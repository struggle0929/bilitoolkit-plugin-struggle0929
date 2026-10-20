/** Preserve integer identifiers beyond Number.MAX_SAFE_INTEGER, including next_id.
 * Scan JSON tokens without touching numbers inside quoted strings. */
export function parseLosslessJson(text: string): unknown {
  let output = ''
  let quoted = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quoted) {
      output += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') {
      quoted = true
      output += char
      continue
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      const token = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0]
      if (token) {
        output += !/[.eE]/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token
        index += token.length - 1
        continue
      }
    }
    output += char
  }
  return JSON.parse(output)
}
