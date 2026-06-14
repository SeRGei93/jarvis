import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "strip-tools" });

// Inline tool-call leaked onto its own line, e.g.
//   kufar_search{"key":"val"}   or   web_search(query="...")
// Port of Go's leakedToolCallRe (multiline).
const INLINE_RE = /^[ \t]*[a-z][a-z0-9_]*(?:\([^)]*\)|\{[^}]*\})[ \t]*$/gm;

// XML-style tool-call blocks: <function_calls>...</function_calls> / <tool_call>...</tool_call>
// Port of Go's leakedXMLToolCallRe (dotall). Unterminated blocks run to end-of-string.
const XML_RE =
  /<function_calls[\s>][\s\S]*?(?:<\/function_calls>|$)|<tool_call[\s>][\s\S]*?(?:<\/tool_call>|$)/g;

export interface StripResult {
  text: string;
  stripped: number;
}

/** Remove tool-call syntax that leaked into the model's text output. */
export function stripLeakedToolCalls(input: string): StripResult {
  let stripped = 0;
  const count = (): string => {
    stripped++;
    return "";
  };
  let out = input.replace(XML_RE, count);
  out = out.replace(INLINE_RE, count);
  out = out.trim();
  if (stripped > 0) log.debug({ stripped }, "stripped leaked tool-calls");
  return { text: out, stripped };
}
