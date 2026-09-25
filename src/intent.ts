// Cheap, model-free guess at whether a prompt asks for a code change. It only decides whether
// megaprobe adds a hint; the session model still makes the final call, so false positives cost
// a sentence of context and false negatives just mean the prompt is handled normally.

const CHANGE = /\b(fix|add|implement|create|build|refactor|rename|update|change|remove|delete|drop|migrate|upgrade|bump|write|make|support|handle|convert|replace|optimi[sz]e|debug|resolve|port|extract|split|move|wire|hook up|integrate|introduce|clean ?up|rewrite|patch)\b/i
const QUESTION_START = /^(what|why|how|where|when|who|which|is|are|was|were|does|do|did|can|could|should|would|will|explain|describe|summari[sz]e|tell me|show me|list|compare|review)\b/i
// Asking about how to change something ("how do I add X?") is a question, not an order.
const HOW_TO = /\bhow (do|would|should|can|could) (i|we|you)\b/i
// "Can you fix X?" is a polite order, not a question.
const POLITE = /^(please\b|(can|could|would|will) you\b)/i
// "Review and fix X": an informational opener that chains an instruction.
const CHAINED = new RegExp(`\\b(and|then)\\s+(${CHANGE.source.replace(/^\\b\(|\)\\b$/g, '')})\\b`, 'i')
const OPT_OUT = /\b(without|no|skip|don'?t use) megaprobe\b/i

export type AutoMode = 'smart' | 'always' | 'off'

export function wantsPipeline(prompt: string, mode: AutoMode): boolean {
  const p = prompt.trim()
  if (mode === 'off' || !p) return false
  if (/^[/!#]/.test(p)) return false // slash commands, shell escapes, memory notes
  if (OPT_OUT.test(p)) return false
  if (/\bmegaprobe\b/i.test(p)) return true
  if (mode === 'always') return p.length >= 15
  return looksLikeChange(p)
}

export function looksLikeChange(p: string): boolean {
  if (p.length < 15) return false
  const firstLine = p.split('\n')[0] ?? p
  if (HOW_TO.test(firstLine)) return false
  if (POLITE.test(firstLine)) return CHANGE.test(p)
  if (QUESTION_START.test(firstLine)) return CHAINED.test(p)
  return CHANGE.test(p)
}
