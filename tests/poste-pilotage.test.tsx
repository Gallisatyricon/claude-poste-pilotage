import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const PANE = {
  plugin: 'poste-pilotage',
  component: 'Pane',
  requestId: 'pilotage',
  props: {
    title: 'Poste de pilotage',
    isFocused: false,
    bodyColumns: 36,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const ASK = {
  tool: 'AskUserQuestion',
  questions: [
    {
      question: 'Faut-il garder l’ancienne base ?',
      header: 'Base',
      multiSelect: false,
      options: [
        { label: 'Oui', description: 'On la garde' },
        { label: 'Non', description: 'On repart à zéro' },
      ],
    },
  ],
  metadata: { source: 'sous-agent:migrateur' },
} as const

// Ce qui se tient sous le mod et joue le rôle du moteur.
function engine(on: any, statuses: (string | undefined)[]) {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'pilotage' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_: unknown, e: { text: string | undefined }) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000, tokens: 122000, percent: 61 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 40 }],
    },
  }))
  on('agent.list', () => ({
    value: [
      { id: 'a1', description: 'Migrer la base', type: 'general-purpose', status: 'running', name: 'migrateur' },
    ],
  }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  return clock
}

test('la ligne d’état donne décisions, contexte et forfait', async ($, on) => {
  const statuses: (string | undefined)[] = []
  engine(on, statuses)
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })

  expect(statuses.at(-1)).toBe('Aucune décision en attente · contexte 61 % · forfait 5 h : 40 %')
})

test('une question apparaît à trancher puis disparaît une fois répondue, sur chaque surface', async ($, on) => {
  const statuses: (string | undefined)[] = []
  const clock = engine(on, statuses)
  let answer: () => void = () => {}
  const answered = new Promise<void>(resolve => (answer = resolve))
  on('tool.call', async () => {
    await answered
    return { result: { answers: { 'Faut-il garder l’ancienne base ?': 'Oui' } } }
  })

  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  // Appel non typé : avec les outils MCP connectés, l'union complète est trop profonde.
  const callTool = $.tool.call as unknown as (input: unknown) => Promise<unknown>
  const pending = callTool(ASK)
  // Laisse le mod enregistrer la question avant de regarder.
  for (let i = 0; i < 50 && !statuses.at(-1)?.startsWith('1 décision'); i++) {
    await clock.settle()
  }
  expect(statuses.at(-1)).toBe('1 décision en attente · contexte 61 % · forfait 5 h : 40 %')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /ancienne base/ }))?.text).toContain('Faut-il garder')
    expect((await ui.find({ type: 'Text', text: /Orchestrateur pour « migrateur »/ }))?.text).toContain(
      "à l'instant",
    )
    await ui.unmount()
  }

  // Trois minutes plus tard, l'ancienneté suit.
  await clock.advance(3 * 60_000)
  const later = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect((await later.find({ type: 'Text', text: /migrateur/ }))?.text).toContain('depuis 3 min')
  await later.unmount()

  answer()
  await pending
  expect(statuses.at(-1)).toBe('Aucune décision en attente · contexte 61 % · forfait 5 h : 40 %')
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect((await ui.find({ type: 'Text', text: /Rien à trancher/ }))?.text).toBe("Rien à trancher pour l'instant.")
  await ui.unmount()
})

test('l’arbre montre le sous-agent et un message lui part directement', async ($, on) => {
  const statuses: (string | undefined)[] = []
  engine(on, statuses)
  on('tool.call', () => ({ result: {} }))
  const sent: { to: string; text: string }[] = []
  on('session.send', (_: unknown, e: { to: string; text: string }) => {
    sent.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const callTool = $.tool.call as unknown as (input: unknown) => Promise<unknown>
  await callTool({ tool: 'Read', file_path: '/a.txt', agentId: 'a1' })
  await callTool({ tool: 'Grep', pattern: 'x', agentId: 'a1' })

  for (const surface of ['desktop', 'vscode', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-agents' })
    expect((await ui.find({ type: 'Text', text: /recherche dans les fichiers · 2 actions/ }))?.text).toContain('0 tokens')
    await ui.press({ key: 'a-a1' })
    expect((await ui.find({ type: 'Text', text: /Message à/ }))?.text).toBe('Message à « migrateur »')
    await ui.input({ key: 'message', text: 'Arrête-toi après ce fichier.' })
    await ui.press({ key: 'tab-decisions' })
    await ui.unmount()
  }

  expect(sent.length).toBe(3)
  expect(sent[0]?.text).toBe('Arrête-toi après ce fichier.')
  expect(sent[0]?.to).toContain('a1')
})

test('la consigne d’origine n’est ajoutée que là où l’outil de question est offert', async ($, on) => {
  on('prompt.compose', (_: unknown, e: { tools: readonly string[] }) => ({
    sections: [{ id: 'intro', text: 'base', scope: 'shared' }],
  }))

  const withAsk = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [], tools: ['AskUserQuestion', 'Read'] })
  expect(withAsk.sections.map(s => s.id)).toEqual(['intro', 'poste-pilotage:origine'])

  const withoutAsk = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [], tools: ['Read'] })
  expect(withoutAsk.sections.map(s => s.id)).toEqual(['intro'])
})

test('les tokens et la fin d’un sous-agent apparaissent dans l’arbre', async ($, on) => {
  const statuses: (string | undefined)[] = []
  engine(on, statuses)
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: 'm',
        input_tokens: 300,
        output_tokens: 700,
        cache_read_input_tokens: 40000,
        cache_creation_input_tokens: 1300,
      },
    }
  })
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1, agentId: 'a1' })
  for await (const _chunk of stream) {
    // lu jusqu'au bout
  }
  await stream.result
  await $.turn.complete({
    answer: 'fini',
    durationMs: 10,
    isAborted: false,
    turnId: 't1',
    agentId: 'a1',
    reason: 'answer',
  } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'tab-agents' })
  expect((await ui.find({ type: 'Text', text: /tokens/ , }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /42,3\u00a0k tokens/ }))?.text).toContain('0 action')
  expect((await ui.find({ type: 'Text', text: /terminé/ }))?.text).toContain('terminé')
  await ui.unmount()
})
