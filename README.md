# poste-pilotage

Un mod Claude Code pour piloter un orchestrateur et ses sous-agents sans perdre le fil de ce qu'on doit trancher.

## Pourquoi

Quand un orchestrateur fait travailler plusieurs sous-agents, les questions qui te sont posées se noient au milieu des rapports intermédiaires. On ne sait plus sur quoi on doit décider, ni qui attend quoi. Ce mod rend cette vue : un panneau à côté du fil, dans l'extension VS Code et dans l'onglet Code de l'app Desktop (et dans le terminal).

## Ce qu'il fait

- **À trancher** : les décisions qui t'attendent, chacune dans sa carte, avec qui la pose (l'orchestrateur, et pour quel sous-agent quand il relaie) et depuis quand.
  - Les questions à choix (outil AskUserQuestion), y compris celles relayées pour un sous-agent.
  - Les questions écrites en texte libre en fin de tour, même suivies de quelques actions de clôture : repérées par une règle fixe (point d'interrogation, tournures comme « dis-moi », « tu valides »), sans appel à un modèle.
  - « Voir le détail » ouvre le passage où la question a été posée, ou les options d'une question à choix.
  - « Répondre » ouvre la fenêtre de question native (avec un champ libre multiligne). Avec plusieurs questions, les réponses attendent sur leur carte et partent ensemble, chacune accompagnée de sa question.
  - Seules les questions écrites du dernier tour de l'orchestrateur restent affichées : celles d'avant sont considérées comme dépassées. « Ignorer » et « Vider les questions écrites » retirent à la main celles qui ne servent plus, sans rien envoyer.
- **Agents** : l'orchestrateur et ses sous-agents en arbre, avec leur état, leur dernière action en mots simples, leur nombre d'actions et leurs tokens. « Écrire » envoie un message directement à un sous-agent, sans passer par l'orchestrateur.
- **Ligne d'état permanente** : `2 décisions en attente · contexte 61 % · forfait 5 h : 40 %`.
- **`/pilotage`** ouvre ou ferme le panneau.

## Ce qu'il ne fait pas

- Il n'appelle aucun modèle : il ne consomme pas ton forfait.
- Il ne bloque ni ne modifie aucun appel d'outil, et n'approuve rien à ta place.
- Il ajoute une phrase aux consignes de l'orchestrateur : passer par l'outil de question pour toute décision, et indiquer le sous-agent concerné quand il relaie une question.

## Installation

À l'invite d'une session Claude Code dans un terminal :

```
/plugin install poste-pilotage --marketplace Gallisatyricon/claude-poste-pilotage
```

Réponds `y` pour ajouter le catalogue, puis choisis la portée (« user » pour toutes tes sessions).

Depuis un shell :

```
claude plugin install poste-pilotage --marketplace Gallisatyricon/claude-poste-pilotage
```

Dans l'app Desktop, où `/plugin` ne fonctionne pas : clique + à côté de la zone de saisie, puis Plugins, Add marketplace avec `Gallisatyricon/claude-poste-pilotage`, puis Add plugin.

Ensuite, dans une nouvelle session, tape `/pilotage`.

## Limites connues

- Un sous-agent n'a pas l'outil de question : ses questions arrivent par l'orchestrateur.
- Ni l'app Desktop ni VS Code ne laissent un mod faire défiler le fil jusqu'à une question : le détail s'affiche dans le panneau à la place.
- Une demande sans point d'interrogation ni tournure reconnue échappe au repérage des questions écrites.

Construit et testé avec Claude Code 2.1.325. L'API des mods est en accès anticipé et peut changer d'une version à l'autre.
