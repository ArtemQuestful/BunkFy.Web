export type AuthenticationChallenge = {
  acceptedContextReferences: string[];
  maxAuthenticationAgeSeconds?: number;
};

// Read the single Bearer challenge emitted by GMA (RFC 9470). This is a UI
// hint, never authorization. Bound input and use linear scans; ambiguous, duplicate
// or malformed parameters cannot silently select a different ceremony.
export function parseAuthenticationChallenge(header: string | null): AuthenticationChallenge | undefined {
  if (!header || header.length > 8192) return;
  for (let index = 0; index < header.length; index++) {
    const character = header.charCodeAt(index);
    if ((character < 32 && character !== 9) || character === 127) return;
  }
  const prefix = /^[ \t]*Bearer[ \t]+/i.exec(header);
  if (!prefix) return;
  let cursor = prefix[0].length;
  const parameters = new Map<string, string>();
  const tokenCharacter = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;
  const whitespace = () => { while (header[cursor] === " " || header[cursor] === "\t") cursor++; };
  const token = () => {
    const start = cursor;
    while (cursor < header.length && tokenCharacter.test(header[cursor])) cursor++;
    return header.slice(start, cursor);
  };

  while (cursor < header.length) {
    whitespace();
    const name = token().toLowerCase();
    whitespace();
    if (!name || parameters.has(name) || header[cursor++] !== "=") return;
    whitespace();
    let value: string;
    if (header[cursor] === '"') {
      cursor++;
      const characters: string[] = [];
      while (cursor < header.length && header[cursor] !== '"') {
        if (header[cursor] === "\\") cursor++;
        if (cursor >= header.length) return;
        characters.push(header[cursor++]);
      }
      if (header[cursor++] !== '"') return;
      value = characters.join("");
    } else {
      value = token();
      if (!value) return;
    }
    parameters.set(name, value);
    whitespace();
    if (cursor === header.length) break;
    if (header[cursor++] !== ",") return;
    whitespace();
    if (cursor === header.length) return;
  }

  if (parameters.get("error") !== "insufficient_user_authentication") return;
  const contexts = parameters.get("acr_values");
  const acceptedContextReferences = contexts?.split(" ").filter(Boolean) ?? [];
  if (contexts !== undefined && acceptedContextReferences.length === 0) return;
  const age = parameters.get("max_age");
  let maxAuthenticationAgeSeconds: number | undefined;
  if (age !== undefined) {
    if (!/^\d+$/.test(age)) return;
    maxAuthenticationAgeSeconds = Number(age);
    if (!Number.isSafeInteger(maxAuthenticationAgeSeconds)) return;
  }
  return { acceptedContextReferences, maxAuthenticationAgeSeconds };
}
