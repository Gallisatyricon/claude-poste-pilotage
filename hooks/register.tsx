// Poste de pilotage : observe et affiche, ne bloque ni ne modifie aucun appel
// d'outil, n'appelle aucun modèle.
import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, TurnUsage } from 'claude-code'

import type { AgentRow, Decision, Gauge, Tab } from '../types'

type Engine = EngineInterface

const PANE = 'pilotage'
const TITLE = 'Poste de pilotage'
const MAIN = 'main'
const SOURCE_PREFIX = 'sous-agent:'
const NBSP = ' '
const NL = String.fromCharCode(10)

const decisions = atom(
  { plugin: 'poste-pilotage', key: 'decisions' } as const,
  [] as Decision[],
  { shape: 'decisions-1' },
)
const agents = atom(
  { plugin: 'poste-pilotage', key: 'agents' } as const,
  {} as Record<string, AgentRow>,
  { shape: 'agents-1' },
)
const tab = atom({ plugin: 'poste-pilotage', key: 'tab' } as const, 'decisions' as Tab, {
  shape: 'tab-1',
})
const selected = atom({ plugin: 'poste-pilotage', key: 'selected' } as const, '', {
  shape: 'selected-1',
})
const expanded = atom({ plugin: 'poste-pilotage', key: 'expanded' } as const, '', {
  shape: 'expanded-1',
})
const gauge = atom({ plugin: 'poste-pilotage', key: 'gauge' } as const, {} as Gauge, {
  shape: 'gauge-1',
})
const tick = atom({ plugin: 'poste-pilotage', key: 'tick' } as const, 0, { shape: 'tick-1' })

// Variante B : une phrase ajoutée aux consignes de l'orchestrateur, pour qu'il
// dise pour quel sous-agent il relaie une question. Rien d'autre n'est changé.
const ORIGIN_SECTION = {
  id: 'poste-pilotage:origine',
  scope: 'session',
  text:
    "Toute question, demande de choix, de validation ou de décision adressée à " +
    "l'utilisateur passe par l'outil AskUserQuestion, jamais par du texte libre " +
    "dans ta réponse : l'utilisateur suit ses décisions en attente dans un panneau " +
    "qui ne voit que cet outil. Cela vaut aussi pour les questions que te remontent " +
    'les sous-agents. ' +
    "Quand tu poses une question à l'utilisateur avec AskUserQuestion pour relayer " +
    "la question ou le blocage d'un sous-agent, renseigne metadata.source avec " +
    `"${SOURCE_PREFIX}" suivi du nom de ce sous-agent (ou, à défaut, de la courte ` +
    "description de sa tâche). Quand la question vient de toi, ne renseigne pas " +
    'metadata.source.',
} as const

// ---------- Mise en forme ----------

const STATUS_WORDS: Record<string, string> = {
  pending: 'démarre',
  running: 'actif',
  waiting: 'patiente',
  idle: 'en veille',
  completed: 'terminé',
  failed: 'échoué',
  killed: 'arrêté',
}

export function decisionsLine(n: number): string {
  if (n === 0) return 'Aucune décision en attente'
  return n === 1 ? '1 décision en attente' : `${n} décisions en attente`
}

export function statusText(n: number, g: Gauge): string {
  const parts = [decisionsLine(n)]
  if (g.context !== undefined) parts.push(`contexte ${Math.round(g.context)}${NBSP}%`)
  if (g.fiveHour !== undefined) parts.push(`forfait 5${NBSP}h : ${Math.round(g.fiveHour)}${NBSP}%`)
  return parts.join(' · ')
}

export function sinceText(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60000)
  if (min < 1) return "à l'instant"
  if (min < 60) return `depuis ${min}${NBSP}min`
  const h = Math.floor(min / 60)
  const rest = String(min % 60).padStart(2, '0')
  return `depuis ${h}${NBSP}h${NBSP}${rest}`
}

// Le nom d'un outil en mots simples, pour la dernière action de chaque agent.
const TOOL_WORDS: Record<string, string> = {
  Bash: 'commande',
  PowerShell: 'commande',
  Read: 'lecture de fichier',
  Edit: 'modification de fichier',
  MultiEdit: 'modification de fichier',
  NotebookEdit: 'modification de fichier',
  Write: 'écriture de fichier',
  Grep: 'recherche dans les fichiers',
  Glob: 'recherche de fichiers',
  Agent: "lancement d'un sous-agent",
  Task: "lancement d'un sous-agent",
  AskUserQuestion: 'question',
  SendMessage: 'message à un agent',
  SubagentHandback: 'rapport final',
  WebSearch: 'recherche web',
  WebFetch: "lecture d'une page web",
  TodoWrite: 'liste de tâches',
  TaskCreate: 'liste de tâches',
  TaskUpdate: 'liste de tâches',
  update_plan: 'liste de tâches',
  wrap_up: 'bilan de fin de tour',
  Skill: 'compétence',
  ToolSearch: "chargement d'outils",
  Monitor: 'surveillance',
  ScheduleWakeup: 'programmation',
  CronCreate: 'programmation',
  Artifact: 'page publiée',
  ExitPlanMode: 'plan proposé',
  EnterPlanMode: 'mode plan',
}

/** « mcp__serveur__outil » devient le nom court de l'outil, traduit quand on le connaît. */
export function toolLabel(name: string): string {
  if (TOOL_WORDS[name]) return TOOL_WORDS[name]
  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    const server = parts[1] ?? ''
    const short = parts.slice(2).join(' ') || server
    if (TOOL_WORDS[short]) return TOOL_WORDS[short]
    if (/browser|chrome/i.test(server)) return 'navigateur'
    return short.replace(/_/g, ' ')
  }
  return name
}

export function tokensText(n: number): string {
  if (n < 1000) return `${n} tokens`
  const k = Math.round(n / 100) / 10
  return `${String(k).replace('.', ',')}${NBSP}k tokens`
}

function usageTotal(u: TurnUsage): number {
  return u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
}

function mainRow(now: number): AgentRow {
  return {
    id: MAIN,
    label: 'Orchestrateur',
    kind: 'principal',
    status: 'en veille',
    toolCount: 0,
    tokens: 0,
    startedAt: now,
  }
}

function rowFromInfo(info: AgentInfo, now: number, old?: AgentRow): AgentRow {
  return {
    id: info.id,
    parentId: info.parentId ?? MAIN,
    label: info.name ?? (info.description || old?.label || info.type),
    kind: info.type,
    status: STATUS_WORDS[info.status] ?? info.status,
    lastTool: old?.lastTool,
    toolCount: old?.toolCount ?? 0,
    tokens: old?.tokens ?? 0,
    startedAt: old?.startedAt ?? now,
  }
}

/** Les agents dans l'ordre de l'arbre, chacun avec sa profondeur. */
export function treeOrder(map: Record<string, AgentRow>): { row: AgentRow; depth: number }[] {
  const rows = Object.values(map)
  const byParent = new Map<string, AgentRow[]>()
  for (const row of rows) {
    if (row.id === MAIN) continue
    const parent = row.parentId && map[row.parentId] ? row.parentId : MAIN
    const list = byParent.get(parent) ?? []
    list.push(row)
    byParent.set(parent, list)
  }
  const out: { row: AgentRow; depth: number }[] = []
  const seen = new Set<string>()
  const walk = (id: string, depth: number) => {
    const kids = (byParent.get(id) ?? []).sort((a, b) => a.startedAt - b.startedAt)
    for (const kid of kids) {
      if (seen.has(kid.id)) continue
      seen.add(kid.id)
      out.push({ row: kid, depth })
      walk(kid.id, depth + 1)
    }
  }
  const main = map[MAIN]
  if (main) out.push({ row: main, depth: 0 })
  walk(MAIN, main ? 1 : 0)
  return out
}

function questionOf(input: unknown): { question: string; extra: number; source?: string; context: string } {
  const value = input as {
    questions?: { question?: unknown }[]
    metadata?: { source?: unknown }
  }
  const list = Array.isArray(value.questions) ? value.questions : []
  const first = list[0]?.question
  const source = value.metadata?.source
  const context = list
    .map(item => {
      const q = item as { question?: unknown; options?: { label?: unknown; description?: unknown }[] }
      const title = typeof q.question === 'string' ? `**${q.question}**` : ''
      const options = (Array.isArray(q.options) ? q.options : [])
        .map(o => `- ${String(o.label ?? '')}${typeof o.description === 'string' && o.description ? ` — ${o.description}` : ''}`)
        .join(NL)
      return [title, options].filter(Boolean).join(NL)
    })
    .join(NL + NL)
  return {
    question: typeof first === 'string' && first.trim() ? first.trim() : '(question sans texte)',
    extra: Math.max(0, list.length - 1),
    source: typeof source === 'string' ? source : undefined,
    context,
  }
}

// Filet : une question écrite en texte libre à la fin du tour de l'orchestrateur.
// Règle fixe, sans modèle : un point d'interrogation, ou une tournure de demande,
// dans les dernières lignes de sa réponse (hors blocs de code).
const ASK_PHRASES =
  /\b(dis-moi|dites-moi|confirme[sz]?|valides?-tu|tu valides|vous validez|préfères-tu|préférez-vous|tu préfères|à toi de (choisir|trancher|décider)|ton accord|ta validation|ton feu vert|let me know|should i|do you want|would you like|please confirm)\b/i
const LAST_LINES = 6
const EXCERPT_MAX = 160

function hasQuestionMark(line: string): boolean {
  // Un « ? » d'adresse web (?a=b) ne compte pas.
  return /\?(\s|$|["'»)*_])/.test(line + ' ')
}

function cleanLine(line: string): string {
  return line
    .replace(/^\s*(>+|#+|[-*+]|\d+[.)])\s*/, '')
    .replace(/[*_`]+/g, '')
    .trim()
}

export function textQuestion(answer: string): string | undefined {
  const lines: string[] = []
  let inCode = false
  for (const raw of answer.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inCode = !inCode
      continue
    }
    if (!inCode && raw.trim()) lines.push(raw)
  }
  const tail = lines.slice(-LAST_LINES)
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i] ?? ''
    if (hasQuestionMark(line) || ASK_PHRASES.test(line)) {
      const text = cleanLine(line)
      if (!text) continue
      return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX - 1)}…` : text
    }
  }
  return undefined
}

// La réponse de fin de tour n'est que le dernier texte : une question posée juste
// avant quelques actions de clôture (mémoire, liste de tâches) n'y figure pas. On
// garde donc le texte de chaque étape du tour et on regarde les dernières.
const TAIL_STEPS = 5

const CONTEXT_MAX = 2000

// Une question par étape au plus, dans la fenêtre des dernières étapes : aucune
// question de cette fenêtre n'est écartée.
const QUESTIONS_MAX = TAIL_STEPS

/**
 * Les questions des dernières étapes du tour, chacune avec le texte de son étape :
 * une par étape au plus, distinctes, la plus récente en premier, trois au plus.
 */
export function findQuestions(
  stepTexts: readonly string[],
  finalAnswer: string,
): { question: string; context: string }[] {
  const texts = stepTexts.length > 0 ? stepTexts.slice(-TAIL_STEPS) : [finalAnswer]
  const out: { question: string; context: string }[] = []
  for (let i = texts.length - 1; i >= 0 && out.length < QUESTIONS_MAX; i--) {
    const text = texts[i] ?? ''
    const found = textQuestion(text)
    if (found && !out.some(item => item.question === found)) {
      const trimmed = text.trim()
      const context = trimmed.length > CONTEXT_MAX ? `…${trimmed.slice(-CONTEXT_MAX)}` : trimmed
      out.push({ question: found, context })
    }
  }
  return out
}

/** La question la plus récente des dernières étapes du tour, avec le texte de son étape. */
export function findQuestion(
  stepTexts: readonly string[],
  finalAnswer: string,
): { question: string; context: string } | undefined {
  return findQuestions(stepTexts, finalAnswer)[0]
}

/** La question la plus récente dans les textes des dernières étapes du tour. */
export function turnQuestion(stepTexts: readonly string[], finalAnswer: string): string | undefined {
  return findQuestion(stepTexts, finalAnswer)?.question
}

// Textes des étapes du tour en cours de l'orchestrateur, par tour. Perdus à un
// rechargement du mod : on retombe alors sur la réponse finale seule.
const stepTexts = new Map<string, string[]>()

// Les messages qui ne viennent pas de toi. Tout le reste est traité comme ton
// message, y compris « unclassified », l'étiquette qu'un canal non attesté reçoit
// (selon l'app, ce que tu tapes peut arriver ainsi).
const NOT_PERSON_ORIGINS = new Set([
  'task-notification',
  'scheduled-trigger',
  'peer',
  'peer-send-message',
  'coordinator',
  'observer',
  'observer-activity',
  'auto-continuation',
  'plugin',
  'slack-ping',
  'channel',
  'projects-relay',
])

export function isPersonPrompt(kind: string, isMeta?: boolean): boolean {
  return !isMeta && !NOT_PERSON_ORIGINS.has(kind)
}

function relayedFor(source: string | undefined): string | undefined {
  if (!source || !source.startsWith(SOURCE_PREFIX)) return undefined
  const name = source.slice(SOURCE_PREFIX.length).trim()
  return name || undefined
}

// ---------- Écritures (jamais pendant un dessin) ----------

async function syncStatus($: Engine) {
  const list = await read($, decisions)
  const g = await read($, gauge)
  $.ui.status(statusText(list.length, g))
}

async function ensureMain($: Engine) {
  const now = await $.clock.now()
  await update($, agents, map => (map[MAIN] ? map : { ...map, [MAIN]: mainRow(now) }))
}

async function refreshAgents($: Engine) {
  const infos = await $.agent.list()
  const now = await $.clock.now()
  await update($, agents, map => {
    const next = { ...map }
    if (!next[MAIN]) next[MAIN] = mainRow(now)
    for (const info of infos) next[info.id] = rowFromInfo(info, now, next[info.id])
    return next
  })
}

async function patchAgent($: Engine, id: string, patch: (row: AgentRow) => AgentRow) {
  let known = (await read($, agents))[id] !== undefined
  if (!known && id !== MAIN) {
    await refreshAgents($)
    known = (await read($, agents))[id] !== undefined
  }
  const now = await $.clock.now()
  await update($, agents, map => {
    const base =
      map[id] ??
      (id === MAIN
        ? mainRow(now)
        : {
            id,
            parentId: MAIN,
            label: 'Sous-agent',
            kind: 'inconnu',
            status: 'actif',
            toolCount: 0,
            tokens: 0,
            startedAt: now,
          })
    return { ...map, [id]: patch(base) }
  })
}

async function setGaugeFrom(
  $: Engine,
  context: { percent?: number },
  limits: readonly { kind: string; percentUsed: number }[],
) {
  const five = limits.find(limit => limit.kind === 'five_hour')
  await update($, gauge, g => ({
    context: context.percent ?? g.context,
    fiveHour: five ? five.percentUsed : g.fiveHour,
  }))
  await syncStatus($)
}

async function sendTo($: Engine, id: string, label: string, text: string) {
  const body = text.trim()
  if (!body) return
  const sent = await $.session.send({ to: { agentId: id }, text: body })
  if (sent.isDelivered) {
    $.ui.toast(`Message déposé pour « ${label} ». Il le lira à sa prochaine étape.`)
    await update($, selected, () => '')
  } else {
    $.ui.toast(`Message non envoyé : ${sent.reason}`)
  }
}

async function toggleQuestion($: Engine, d: Decision) {
  // Le détail s'ouvre dans le panneau : ni l'app Desktop ni VS Code ne laissent
  // un mod faire défiler le fil (« transcript not scrollable here »).
  await update($, expanded, open => (open === d.id ? '' : d.id))
}

/** Réponse longue : la fenêtre de question native, dont le champ « Autre » est multiligne. */
async function replyLong($: Engine, d: Decision) {
  const asked = d.question.trim().endsWith('?') ? d.question : `Ta réponse à « ${d.question} » ?`
  let text: string
  try {
    text = await $.ui.ask(asked, { options: ['Oui', 'Non'], header: 'Réponse' })
  } catch {
    return // fenêtre fermée sans réponse
  }
  await recordReply($, d, text)
}

/**
 * Note la réponse à une question écrite. Seule question en attente : elle part
 * tout de suite. Sinon elle attend sur sa carte, et « Envoyer mes réponses »
 * les envoie toutes ensemble, pour que l'orchestrateur ne reparte pas avant.
 */
async function recordReply($: Engine, d: Decision, text: string) {
  const body = text.trim()
  if (!body) return
  const waiting = (await read($, decisions)).filter(x => x.kind === 'texte')
  if (waiting.length <= 1) {
    await sendAnswers($, [{ ...d, answer: body }])
    return
  }
  await update($, decisions, list => list.map(x => (x.id === d.id ? { ...x, answer: body } : x)))
  $.ui.toast('Réponse notée. Envoie tes réponses quand tu as fini.')
}

/** Le message envoyé : chaque réponse avec sa question, pour lever toute ambiguïté. */
export function answersMessage(items: readonly Decision[]): string {
  const only = items[0]
  if (items.length === 1 && only?.answer) return `À propos de « ${only.question} » : ${only.answer}`
  return [
    'Mes réponses à tes questions :',
    ...items.map(
      (x, i) => `${i + 1}. « ${x.question} » → ${x.answer ?? "(pas de réponse pour l'instant)"}`,
    ),
  ].join(NL)
}

async function sendAnswers($: Engine, items?: readonly Decision[]) {
  const all = items ?? (await read($, decisions)).filter(x => x.kind === 'texte')
  if (!all.some(x => x.answer)) return
  // Tes réponses répondent aux questions écrites : elles sortent de la liste.
  await update($, decisions, list => list.filter(x => x.kind !== 'texte'))
  await syncStatus($)
  const sent = await $.prompt.submit({ text: answersMessage(all), asUser: true })
  $.ui.toast(
    sent.drop === undefined
      ? "Réponses envoyées à l'orchestrateur."
      : `Réponses non envoyées : ${sent.drop}`,
  )
}

/** Retire une question écrite dépassée, ou toutes si aucun id n'est donné. Rien n'est envoyé. */
async function dismiss($: Engine, id?: string) {
  await update($, decisions, list =>
    list.filter(d => d.kind !== 'texte' || (id !== undefined && d.id !== id)),
  )
  await syncStatus($)
}

async function togglePane($: Engine) {
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (isUp) {
    await $.ui.close({ id: PANE })
    return
  }
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  if (!opened.isPlaced) $.ui.toast(`Le poste de pilotage s'affichera dès que possible (${opened.reason}).`)
}

// ---------- Les crochets ----------

let timer: { cancel: () => void } | undefined


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'pilotage',
      description: 'Ouvrir ou fermer le poste de pilotage',
      immediate: true,
    })
    // Une question restée d'avant un rechargement ne peut plus être suivie.
    await update($, decisions, () => [])
    await ensureMain($)
    const usage = await $.session.usage()
    await setGaugeFrom($, usage.context, usage.rateLimits)
    timer?.cancel()
    timer = $.clock.every(30000, () => {
      void (async () => {
        if ((await read($, decisions)).length > 0) await update($, tick, n => n + 1)
      })()
    })
    return started
  })

  on('command.run', { command: 'pilotage' }, async $ => {
    await togglePane($)
    return {}
  })

  // Variante B : seulement là où l'outil de question est offert (l'orchestrateur).
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes('AskUserQuestion')) return composed
    return { sections: [...composed.sections, ORIGIN_SECTION] }
  })

  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    await setGaugeFrom($, e.context, e.rateLimits)
    return measured
  })

  // Observe chaque appel d'outil sans le modifier : le résultat est rendu tel quel.
  on('tool.call', async ($, e, next) => {
    const who = e.agentId ?? MAIN
    let decisionId: string | undefined
    try {
      await patchAgent($, who, row => ({
        ...row,
        lastTool: String(e.tool),
        toolCount: row.toolCount + 1,
        status: 'actif',
      }))
      // La fenêtre que le mod ouvre lui-même pour une réponse longue n'est pas une décision.
      if (String(e.tool) === 'AskUserQuestion' && next.origin.plugin !== $.plugin.name) {
        const asked = questionOf(e)
        const now = await $.clock.now()
        decisionId = e.tool_use_id
        const decision: Decision = {
          id: decisionId,
          question: asked.question,
          extra: asked.extra,
          askedBy: who,
          forAgent: relayedFor(asked.source),
          since: now,
          context: asked.context,
        }
        await update($, decisions, list => [...list.filter(d => d.id !== decision.id), decision])
        await syncStatus($)
      }
    } catch {
      // L'observation ne doit jamais gêner l'appel.
    }
    try {
      return await next(e)
    } finally {
      if (decisionId !== undefined) {
        const id = decisionId
        await update($, decisions, list => list.filter(d => d.id !== id))
        await syncStatus($)
      }
    }
  }).catch(($, e, next) => next(e))

  // Ton prochain message répond aux questions écrites en texte : elles sortent de la liste.
  on('prompt.submit', async ($, e, next) => {
    const submitted = await next(e)
    if (isPersonPrompt(e.origin.kind, e.isMeta)) {
      const list = await read($, decisions)
      if (list.some(d => d.kind === 'texte')) {
        await update($, decisions, all => all.filter(d => d.kind !== 'texte'))
        await syncStatus($)
      }
    }
    return submitted
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const id = spawned.agentId
    if (id) {
      const now = await $.clock.now()
      await update($, agents, map => ({
        ...map,
        [id]: {
          id,
          parentId: e.parentAgentId ?? MAIN,
          label: e.name ?? e.description,
          kind: e.subagentType,
          status: 'démarre',
          toolCount: map[id]?.toolCount ?? 0,
          tokens: map[id]?.tokens ?? 0,
          lastTool: map[id]?.lastTool,
          startedAt: map[id]?.startedAt ?? now,
        },
      }))
    }
    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    await patchAgent($, e.agentId ?? MAIN, row => ({ ...row, status: 'actif' }))
    return started
  })

  on('turn.step', async function* ($, e, next) {
    const stepped = yield* next(e)
    if (e.agentId === undefined) {
      const texts = stepTexts.get(e.turnId) ?? []
      texts.push(stepped.answer)
      stepTexts.set(e.turnId, texts.slice(-TAIL_STEPS))
    }
    if (stepped.usage) {
      const total = usageTotal(stepped.usage)
      await patchAgent($, e.agentId ?? MAIN, row => ({ ...row, tokens: total }))
    }
    return stepped
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId === undefined) {
      // Le tour de l'orchestrateur est fini : aucune question par l'outil ne peut
      // rester ouverte ; une question écrite dans sa réponse, elle, attend.
      const texts = stepTexts.get(e.turnId) ?? []
      stepTexts.delete(e.turnId)
      const found = e.isAborted ? [] : findQuestions(texts, e.answer)
      const now = await $.clock.now()
      // Dans l'ordre où elles ont été posées ; la plus récente garde l'id du tour.
      const fresh: Decision[] = found
        .map((item, k) => ({
          id: k === 0 ? `texte-${e.turnId}` : `texte-${e.turnId}-${k}`,
          question: item.question,
          extra: 0,
          askedBy: MAIN,
          since: now,
          kind: 'texte' as const,
          context: item.context,
        }))
        .reverse()
      await update($, decisions, list => {
        // Seules comptent les questions écrites du dernier tour : celles d'avant
        // sont dépassées, l'orchestrateur est passé à autre chose. On ne garde
        // que celles où tu as déjà noté une réponse, pour ne pas la perdre.
        const kept = list.filter(
          d => d.kind === 'texte' && d.answer && !fresh.some(f => f.question === d.question),
        )
        return [...kept, ...fresh]
      })
      await patchAgent($, MAIN, row => ({
        ...row,
        status: fresh.length > 0 ? 'attend ta réponse' : 'en veille',
      }))
      await syncStatus($)
    } else {
      // L'état réel d'abord : un agent dont le tour finit peut encore attendre son
      // propre travail de fond (« patiente »), puis reprendre.
      const word =
        e.reason === 'answer' ? 'terminé' : e.reason === 'aborted' ? 'arrêté' : 'échoué'
      const infos = await $.agent.list().catch(() => [] as AgentInfo[])
      const info = infos.find(one => one.id === e.agentId)
      const real = info ? STATUS_WORDS[info.status] ?? info.status : undefined
      await patchAgent($, e.agentId, row => ({
        ...row,
        status: real && real !== 'actif' ? real : word,
      }))
    }
    return completed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Markdown } = $.ui.resolve(e)
    const list = await read($, decisions)
    const map = await read($, agents)
    const current = await read($, tab)
    const chosen = await read($, selected)
    const open = await read($, expanded)
    await read($, tick)
    const now = await $.clock.now()
    const isTerminal = e.surface === 'terminal'
    const nameOf = (id: string) => map[id]?.label ?? (id === MAIN ? 'Orchestrateur' : 'Sous-agent')
    const askedLine = (d: Decision) => {
      const by = nameOf(d.askedBy)
      const forWhom = d.forAgent ? ` pour « ${d.forAgent} »` : ''
      const how = d.kind === 'texte' ? ' · question dans le texte' : ''
      return `${by}${forWhom}${how} · ${sinceText(now - d.since)}`
    }

    // Petit format (fenêtre réduite de l'app) : l'essentiel d'un coup d'œil.
    if (e.props.placement === 'widget') {
      const first = list[0]
      return (
        <Box flexDirection="column">
          <Text bold>{decisionsLine(list.length)}</Text>
          {first && <Text wrap="truncate-end">{first.question}</Text>}
        </Box>
      )
    }

    const tree = treeOrder(map)
    const subCount = tree.filter(t => t.row.id !== MAIN).length
    const target = chosen ? map[chosen] : undefined

    const tabs = (
      <Box flexDirection="row" gap={1}>
        <Button
          key="tab-decisions"
          variant={current === 'decisions' ? 'primary' : 'secondary'}
          hotkey={isTerminal ? '1' : undefined}
          onPress={() => void update($, tab, () => 'decisions')}
        >
          À trancher ({list.length})
        </Button>
        <Button
          key="tab-agents"
          variant={current === 'agents' ? 'primary' : 'secondary'}
          hotkey={isTerminal ? '2' : undefined}
          onPress={() => void update($, tab, () => 'agents')}
        >
          Agents ({subCount})
        </Button>
      </Box>
    )

    if (current === 'decisions') {
      const textCount = list.filter(d => d.kind === 'texte').length
      const answeredCount = list.filter(d => d.kind === 'texte' && d.answer).length
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          {list.length === 0 && <Text dimColor>Rien à trancher pour l'instant.</Text>}
          {list.map(d => (
            <Box
              key={`d-${d.id}`}
              flexDirection="column"
              borderStyle="round"
              paddingX={1}
              alignItems="flex-start"
            >
              <Text bold>
                {d.question}
                {d.extra > 0 ? ` (+${d.extra} autre${d.extra > 1 ? 's' : ''})` : ''}
              </Text>
              <Text dimColor wrap="truncate-end">
                {askedLine(d)}
              </Text>
              {open === d.id && (
                <Box flexDirection="column" marginTop={1}>
                  {d.context ? (
                    isTerminal ? (
                      <Text>{d.context}</Text>
                    ) : (
                      <Markdown key={`ctx-${d.id}`} text={d.context} />
                    )
                  ) : (
                    <Text dimColor>Détail non conservé pour cette question.</Text>
                  )}
                </Box>
              )}
              <Box flexDirection="row" gap={1} marginTop={1}>
                <Button key={`q-${d.id}`} onPress={() => void toggleQuestion($, d)}>
                  {open === d.id ? 'Masquer le détail' : 'Voir le détail'}
                </Button>
                {d.kind === 'texte' && (
                  <Button
                    key={`r-${d.id}`}
                    variant={d.answer ? 'secondary' : 'primary'}
                    onPress={() => void replyLong($, d)}
                  >
                    {d.answer ? 'Modifier' : 'Répondre'}
                  </Button>
                )}
                {d.kind === 'texte' && (
                  <Button key={`i-${d.id}`} onPress={() => void dismiss($, d.id)}>
                    Ignorer
                  </Button>
                )}
              </Box>
              {d.answer && <Text dimColor>Ta réponse : {d.answer}</Text>}
              {d.kind !== 'texte' && (
                <Text dimColor>Se répond dans sa fenêtre, en bas du fil.</Text>
              )}
            </Box>
          ))}
          {textCount > 1 && answeredCount > 0 && (
            <Box flexDirection="column" alignItems="flex-start">
              <Button key="send-all" variant="primary" onPress={() => void sendAnswers($)}>
                Envoyer mes réponses ({answeredCount}/{textCount})
              </Button>
              {answeredCount < textCount && (
                <Text dimColor>Les questions sans réponse seront signalées comme telles.</Text>
              )}
            </Box>
          )}
          {textCount > 1 && (
            <Box alignItems="flex-start">
              <Button key="clear-all" onPress={() => void dismiss($)}>
                Vider les questions écrites
              </Button>
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {target && (
          <Box flexDirection="column" borderStyle="round" paddingX={1} alignItems="flex-start">
            <Text bold wrap="truncate-end">
              Message à « {target.label} »
            </Text>
            <Input
              key="message"
              placeholder="Ton message…"
              submitLabel="Envoyer"
              onSubmit={value => void sendTo($, target.id, target.label, value)}
            />
            <Button key="cancel" onPress={() => void update($, selected, () => '')}>
              Annuler
            </Button>
          </Box>
        )}
        {subCount === 0 && <Text dimColor>Aucun sous-agent pour l'instant.</Text>}
        {tree.map(({ row, depth }) => {
          const indent = depth === 0 ? '' : `${'  '.repeat(depth - 1)}└ `
          const detail = `${row.lastTool ? toolLabel(row.lastTool) : '—'} · ${row.toolCount} action${
            row.toolCount > 1 ? 's' : ''
          } · ${tokensText(row.tokens)}`
          return (
            <Box key={`r-${row.id}`} flexDirection="column" alignItems="flex-start">
              <Text bold wrap="truncate-end">
                {indent}
                {row.label} <Text dimColor>· {row.status}</Text>
              </Text>
              <Text dimColor wrap="truncate-end">
                {depth === 0 ? '' : '  '.repeat(depth)}
                {detail}
              </Text>
              {row.id !== MAIN && (
                <Button key={`a-${row.id}`} onPress={() => void update($, selected, () => row.id)}>
                  Écrire
                </Button>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
