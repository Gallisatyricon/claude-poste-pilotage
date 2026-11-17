/** Une question posée par l'outil AskUserQuestion et pas encore répondue. */
export type Decision = {
  /** L'identifiant de l'appel d'outil. */
  id: string
  /** La première question posée. */
  question: string
  /** Le nombre de questions supplémentaires dans le même appel. */
  extra: number
  /** Qui pose la question : 'main' pour l'orchestrateur, sinon l'id de l'agent. */
  askedBy: string
  /** Le sous-agent pour lequel l'orchestrateur relaie la question, s'il l'a indiqué. */
  forAgent?: string
  /** Quand la question est apparue (millisecondes de $.clock.now()). */
  since: number
  /** 'texte' : repérée dans la réponse de fin de tour, sans l'outil de question. */
  kind?: 'outil' | 'texte'
  /** Le passage où la question a été posée (ou ses options), pour l'afficher dans le panneau. */
  context?: string
  /** Ta réponse notée sur la carte, pas encore envoyée (questions écrites seulement). */
  answer?: string
}

/** Une ligne de l'arbre des agents. */
export type AgentRow = {
  /** 'main' pour l'orchestrateur, sinon l'id de l'agent. */
  id: string
  /** L'agent parent ; absent pour l'orchestrateur. */
  parentId?: string
  /** Le nom affiché. */
  label: string
  /** Le type d'agent (general-purpose, Explore, ...). */
  kind: string
  /** L'état, en mots simples. */
  status: string
  /** Le dernier outil utilisé. */
  lastTool?: string
  /** Le nombre d'appels d'outils. */
  toolCount: number
  /** Les tokens de sa dernière requête au modèle (même convention que Claude Code). */
  tokens: number
  /** Ordre d'apparition. */
  startedAt: number
}

/** Les chiffres de la ligne d'état. */
export type Gauge = {
  /** Remplissage du contexte, en pourcentage. */
  context?: number
  /** Consommation de la fenêtre de 5 heures du forfait, en pourcentage. */
  fiveHour?: number
}

export type Tab = 'decisions' | 'agents'

declare module 'claude-code' {
  interface PluginState {
    'poste-pilotage': {
      decisions: Shaped<Decision[]>
      agents: Shaped<Record<string, AgentRow>>
      tab: Shaped<Tab>
      selected: Shaped<string>
      expanded: Shaped<string>
      gauge: Shaped<Gauge>
      tick: Shaped<number>
    }
  }
}
