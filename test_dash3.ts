import { matchesSearch } from "./src/shared/utils/turkishText.ts";

const haystack = [
  "ab",
  "openai",
  "OpenAI Main",
  "Work Account",
  "DevKey",
  "SmartRouter",
  "corr-12345",
  null,
  "/v1/chat/completions",
].filter(Boolean).join(" ");
console.log(haystack);
console.log(matchesSearch(haystack, "-"));
