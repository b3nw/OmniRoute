import { matchesSearch } from "./src/shared/utils/turkishText.ts";

const haystack = [
  "ab",
  "openai",
  "OpenAI Main",
  "Work Account",
  "DevKey",
  "SmartRouter",
  null,
  null,
  "/v1/chat/completions",
].filter(Boolean).join(" ");
console.log(haystack);
console.log(matchesSearch(haystack, "-"));
