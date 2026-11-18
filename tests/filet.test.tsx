import { expect, mock, test } from 'claude-code/testing'

import { findQuestions, isPersonPrompt, textQuestion, toolLabel, turnQuestion } from '../hooks/register'

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

test('la règle repère une question en fin de réponse, et seulement là', async () => {
  expect(textQuestion('J’ai fini la page.\n\n**On part sur la version A ou B ?**')).toBe(
    'On part sur la version A ou B ?',
  )
  expect(textQuestion('Tout est prêt.\nDis-moi si je continue.')).toBe('Dis-moi si je continue.')
  expect(textQuestion('Voir https://exemple.fr/page?id=3 pour le détail.\nC’est terminé.')).toBe(undefined)
  expect(textQuestion('Pourquoi ? Parce que.\nl1\nl2\nl3\nl4\nl5\nl6\nTerminé.')).toBe(undefined)
  expect(textQuestion('Voici le code :\n```js\nconst x = a ? b : c\n```\nC’est fait.')).toBe(undefined)
  expect(textQuestion('Tout est en ordre, rien à signaler.')).toBe(undefined)
})

test('une question écrite en fin de tour reste à trancher jusqu’à ton prochain message', async ($, on) => {
  const statuses: (string | undefined)[] = []
  mock.clock(on, { now: 5_000_000 })
  on('command.register', () => ({ value: { command: 'pilotage' } }))
  on('ui.status', (_: unknown, e: { text: string | undefined }) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000 }, rateLimits: [] } }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))

  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await $.turn.complete({
    answer: 'Le module est prêt.\nJe passe à la migration maintenant ?',
    durationMs: 10,
    isAborted: false,
    turnId: 't9',
    reason: 'answer',
  } as any)
  expect(statuses.at(-1)).toBe('1 décision en attente')

  for (const surface of ['vscode', 'desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /migration/ }))?.text).toBe(
      'Je passe à la migration maintenant ?',
    )
    expect((await ui.find({ type: 'Text', text: /question dans le texte/ }))?.text).toContain('Orchestrateur')
    await ui.unmount()
  }

  // Une notification de fond n'est pas ta réponse : la question reste.
  await $.prompt.submit({ text: 'tâche finie', origin: { kind: 'task-notification' } } as any)
  expect(statuses.at(-1)).toBe('1 décision en attente')

  await $.prompt.submit({ text: 'oui vas-y', origin: { kind: 'sdk' } } as any)
  expect(statuses.at(-1)).toBe('Aucune décision en attente')
})

test('une question suivie d’actions de clôture est repérée dans les étapes du tour', async () => {
  // Étape 1 : la question, puis un appel d'outil ; étapes 2-3 : mémoire ; étape 4 : texte final.
  expect(turnQuestion(['Je propose A ou B. Tu préfères laquelle ?', '', '', 'C’est noté en mémoire.'], 'C’est noté en mémoire.')).toBe(
    'Je propose A ou B. Tu préfères laquelle ?',
  )
  // Au-delà des 5 dernières étapes, une vieille question ne remonte plus.
  expect(turnQuestion(['Est-ce le cache ?', '', '', '', '', 'Corrigé, tout passe.'], 'Corrigé, tout passe.')).toBe(undefined)
  // Sans étapes connues (rechargement), on retombe sur la réponse finale.
  expect(turnQuestion([], 'Je continue ?')).toBe('Je continue ?')
})

test('en session : la question d’une étape intermédiaire arrive dans « À trancher »', async ($, on) => {
  const statuses: (string | undefined)[] = []
  mock.clock(on, { now: 9_000_000 })
  on('command.register', () => ({ value: { command: 'pilotage' } }))
  on('ui.status', (_: unknown, e: { text: string | undefined }) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000 }, rateLimits: [] } }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  const answers = ['On garde l’ancienne API ou on migre ?', '', 'C’est noté en mémoire.']
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: answers[e.index] ?? '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't7' })
  for (let index = 0; index < 3; index++) {
    const stream = $.turn.step({ turnId: 't7', index, model: 'm', messageCount: 1 })
    for await (const _chunk of stream) {
      // lu jusqu'au bout
    }
    await stream.result
  }
  await $.turn.complete({
    answer: 'C’est noté en mémoire.',
    durationMs: 10,
    isAborted: false,
    turnId: 't7',
    reason: 'answer',
  } as any)

  expect(statuses.at(-1)).toBe('1 décision en attente')
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect((await ui.find({ type: 'Text', text: /ancienne API/ }))?.text).toBe('On garde l’ancienne API ou on migre ?')
  await ui.unmount()
})

test('plusieurs questions dans la fin du tour sont toutes listées', async () => {
  const steps = [
    'Question de test : veux-tu l’heure de chaque tirage ?',
    '',
    'Long texte…\nUne fois le test fait, dis-moi :\n- si le panneau a marché',
  ]
  const found = findQuestions(steps, steps[2] ?? '')
  expect(found.map(f => f.question)).toEqual([
    'Une fois le test fait, dis-moi :',
    'Question de test : veux-tu l’heure de chaque tirage ?',
  ])
  expect(found[1]?.context).toContain('heure de chaque tirage')
})

test('les noms d’outils sont traduits en mots simples', async () => {
  expect(toolLabel('Bash')).toBe('commande')
  expect(toolLabel('SubagentHandback')).toBe('rapport final')
  expect(toolLabel('mcp__ccd_turn__wrap_up')).toBe('bilan de fin de tour')
  expect(toolLabel('mcp__Claude_Browser__navigate')).toBe('navigateur')
  expect(toolLabel('mcp__recall__fetch_document')).toBe('fetch document')
  expect(toolLabel('OutilInconnu')).toBe('OutilInconnu')
})

test('tes messages sont reconnus, y compris sans étiquette, et les autres non', async () => {
  for (const kind of ['composer', 'bridge', 'sdk', 'unclassified']) expect(isPersonPrompt(kind)).toBe(true)
  for (const kind of ['task-notification', 'peer', 'plugin', 'scheduled-trigger']) expect(isPersonPrompt(kind)).toBe(false)
  expect(isPersonPrompt('composer', true)).toBe(false)
})

test('les questions écrites d’un tour précédent laissent la place à celles du dernier tour', async ($, on) => {
  const statuses: (string | undefined)[] = []
  mock.clock(on, { now: 5_000_000 })
  on('command.register', () => ({ value: { command: 'pilotage' } }))
  on('ui.status', (_: unknown, e: { text: string | undefined }) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000 }, rateLimits: [] } }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  const finish = (turnId: string, answer: string) =>
    $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId, reason: 'answer' } as any)

  await finish('t1', 'Première version prête.\nOn part sur A ?')
  expect(statuses.at(-1)).toBe('1 décision en attente')
  // Un sous-agent finit : l'orchestrateur reprend sans que tu aies répondu, et pose autre chose.
  await $.prompt.submit({ text: 'tâche finie', origin: { kind: 'task-notification' } } as any)
  await finish('t2', 'Le sous-agent a fini.\nJe fusionne les deux branches ?')
  expect(statuses.at(-1)).toBe('1 décision en attente')
  // Un tour qui ne pose rien vide les questions écrites dépassées.
  await finish('t3', 'Fusion faite, tout passe.')
  expect(statuses.at(-1)).toBe('Aucune décision en attente')
})

test('« Ignorer » et « Vider » retirent les questions écrites sans rien envoyer', async ($, on) => {
  const statuses: (string | undefined)[] = []
  const prompts: string[] = []
  mock.clock(on, { now: 5_000_000 })
  on('command.register', () => ({ value: { command: 'pilotage' } }))
  on('ui.status', (_: unknown, e: { text: string | undefined }) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000 }, rateLimits: [] } }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  const texts = ['On supprime le cache ?', 'On garde la v1 ?', 'On publie ?']
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: texts[e.index] ?? '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'tz' })
  for (let index = 0; index < 3; index++) {
    const stream = $.turn.step({ turnId: 'tz', index, model: 'm', messageCount: 1 })
    for await (const _chunk of stream) {
      // lu jusqu'au bout
    }
    await stream.result
  }
  await $.turn.complete({ answer: texts[2], durationMs: 1, isAborted: false, turnId: 'tz', reason: 'answer' } as any)
  expect(statuses.at(-1)).toBe('3 décisions en attente')

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'i-texte-tz' })
  expect(statuses.at(-1)).toBe('2 décisions en attente')
  await ui.press({ key: 'clear-all' })
  expect(statuses.at(-1)).toBe('Aucune décision en attente')
  await ui.unmount()
  expect(prompts.length).toBe(0)
})
