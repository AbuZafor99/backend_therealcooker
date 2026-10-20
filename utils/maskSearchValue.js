// Partly hidden form of a verifier search, kept for the admin search log instead of the full value.
// Expects the normalized value (see normalizeVerificationValue): emails lower-cased, phones as digits,
// account numbers without spaces, websites as host + path.
const DOT = "•";

export function maskSearchValue(type, value) {
  const text = String(value ?? "");
  if (!text) return "";
  switch (type) {
    case "email": {
      const at = text.lastIndexOf("@");
      if (at < 1) return DOT.repeat(3);
      const local = text.slice(0, at);
      return `${local.slice(0, local.length > 3 ? 2 : 1)}${DOT.repeat(3)}${text.slice(at)}`;
    }
    case "phone":
      return text.length > 7 ? `${text.slice(0, 3)}${DOT.repeat(5)}${text.slice(-4)}` : `${DOT.repeat(3)}${text.slice(-2)}`;
    case "account":
      return `${DOT.repeat(4)}${text.slice(text.length > 6 ? -4 : -2)}`;
    case "website":
      // Websites are public; only the host is kept, never paths or query strings that could carry tokens.
      return text.split("/")[0];
    default:
      return DOT.repeat(3);
  }
}
