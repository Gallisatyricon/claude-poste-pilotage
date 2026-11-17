import { expect, mock, test } from 'claude-code/testing'

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

const QUESTION = 'On garde l’ancienne API ou on migre ?'
const ANSWER = `Voici les deux pistes.\n\n**${QUESTION}**`

function engine(on: any, agentList: unknown[] = []) {
  const statuses: (string | undefined)[] = []
  const prompts: { text: string; asUser?: boolean }[] = []
  const clock = mock.clock(on, { now: 7_000_000 })
  on('command.register', () => ({ value: { command: 'pilotage' } }))
  on('ui.status', (_: unknown, e: { text: string | undefined }) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000 }, rateLimits: [] } }))
  on('agent.list', () => ({ value: agentList }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_: unknown, e: { text: string; origin?: { asUser?: boolean } }) => {
    prompts.push({ text: e.text, asUser: e.origin?.asUser })
    return { text: e.text }
  })
  return { statuses, prompts, clock }
}

async function askInText($: any) {
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await $.turn.complete({
    answer: ANSWER,
    durationMs: 10,
    isAborted: false,
    turnId: 't3',
    reason: 'answer',
  })
}

test('« Voir le détail » ouvre puis referme le texte d’origine, sur chaque surface', async ($, on) => {
  engine(on)
  await askInText($)
  for (const surface of ['vscode', 'desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'q-texte-t3' })
    const shown =
      surface === 'terminal'
        ? await ui.find({ type: 'Text', text: /Voici les deux pistes/ })
        : await ui.find({ type: 'Markdown', text: /Voici les deux pistes/ })
    expect(shown).toBeDefined()
    await ui.press({ key: 'q-texte-t3' })
    expect(await ui.find({ text: /Voici les deux pistes/ })).toBe(undefined)
    await ui.unmount()
  }
})

test('une question à choix n’a pas de bouton « Répondre » : elle se répond dans sa fenêtre', async ($, on) => {
  const { statuses, clock } = engine(on)
  let answer: () => void = () => {}
  const answered = new Promise<void>(resolve => (answer = resolve))
  on('tool.call', async () => {
    await answered
    return { result: {} }
  })
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  const callTool = $.tool.call as unknown as (input: unknown) => Promise<unknown>
  const pending = callTool({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Quelle base ?', header: 'Base', multiSelect: false, options: [] }],
  })
  for (let i = 0; i < 50 && !statuses.at(-1)?.startsWith('1 décision'); i++) await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: /Quelle base/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Se répond dans sa fenêtre/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /^Répondre$/ })).toBe(undefined)
  await ui.unmount()
  answer()
  await pending
})

test('« Répondre » ouvre la fenêtre native et envoie le texte comme si tu l’avais tapé', async ($, on) => {
  const { statuses, prompts } = engine(on)
  const LONG = 'On migre, mais en deux temps :\nd’abord la lecture, puis l’écriture.'
  on('tool.call', (_: unknown, e: any) => ({
    result: { questions: e.questions, answers: { [e.questions[0]?.question ?? '']: LONG } },
  }))
  await askInText($)
  expect(statuses.at(-1)).toBe('1 décision en attente')

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'r-texte-t3' })
  expect((await ui.find({ type: 'Text', text: /Rien à trancher/ }))?.text).toBe("Rien à trancher pour l'instant.")
  await ui.unmount()

  expect(prompts).toEqual([{ text: `À propos de « ${QUESTION} » : ${LONG}`, asUser: true }])
  // La fenêtre ouverte par le mod n'a jamais été comptée comme une décision.
  expect(statuses.some(s => s?.startsWith('2 décisions'))).toBe(false)
  expect(statuses.at(-1)).toBe('Aucune décision en attente')
})

test('plusieurs questions écrites : les réponses attendent sur les cartes, puis partent ensemble', async ($, on) => {
  const { statuses, prompts } = engine(on)
  let next = 'Oui'
  on('tool.call', (_: unknown, e: any) => ({
    result: { questions: e.questions, answers: { [e.questions[0]?.question ?? '']: next } },
  }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  const texts = ['On supprime le dossier temporaire ?', '', 'Thème clair ou sombre ?']
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: texts[e.index] ?? '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't5' })
  for (let index = 0; index < 3; index++) {
    const stream = $.turn.step({ turnId: 't5', index, model: 'm', messageCount: 1 })
    for await (const _chunk of stream) {
      // lu jusqu'au bout
    }
    await stream.result
  }
  await $.turn.complete({ answer: texts[2], durationMs: 1, isAborted: false, turnId: 't5', reason: 'answer' } as any)
  expect(statuses.at(-1)).toBe('2 décisions en attente')

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  // La première réponse est notée, rien ne part encore.
  await ui.press({ key: 'r-texte-t5-1' })
  expect(prompts.length).toBe(0)
  expect((await ui.find({ type: 'Text', text: /Ta réponse : Oui/ }))?.text).toBe('Ta réponse : Oui')
  expect((await ui.find({ type: 'Button', text: /Envoyer mes réponses/ }))?.text).toContain('(1/2)')
  next = 'Sombre'
  await ui.press({ key: 'r-texte-t5' })
  expect(prompts.length).toBe(0)
  await ui.press({ key: 'send-all' })
  await ui.unmount()

  expect(prompts.length).toBe(1)
  expect(prompts[0]?.text).toBe(
    [
      'Mes réponses à tes questions :',
      '1. « On supprime le dossier temporaire ? » → Oui',
      '2. « Thème clair ou sombre ? » → Sombre',
    ].join('\n'),
  )
  expect(statuses.at(-1)).toBe('Aucune décision en attente')
})

test('un sous-agent dont le tour finit mais qui attend encore s’affiche « patiente »', async ($, on) => {
  engine(on, [{ id: 'a9', description: 'Veiller', type: 'general-purpose', status: 'waiting', name: 'veilleur' }])
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'tv', agentId: 'a9' })
  await $.turn.complete({ answer: 'en attente', durationMs: 1, isAborted: false, turnId: 'tv', agentId: 'a9', reason: 'answer' } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'tab-agents' })
  expect((await ui.find({ type: 'Text', text: /veilleur/ }))?.text).toContain('patiente')
  await ui.unmount()
})
