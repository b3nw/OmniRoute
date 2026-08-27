import { rowMatchesFilter } from "./src/app/api/usage/call-logs/route.ts";

const baseRow = {
  id: "log-1",
  status: 200,
  model: "openai/gpt-4o",
  provider: "openai",
  providerDisplay: "OpenAI Main",
  account: "Work Account",
  apiKeyName: "DevKey",
  comboName: "SmartRouter",
  correlationId: "corr-12345",
  path: "/v1/chat/completions",
  error: null,
};

console.log(rowMatchesFilter({ ...baseRow, model: "a-b" }, { search: "-" }));
console.log(rowMatchesFilter({ ...baseRow, model: "ab" }, { search: "-" }));
console.log(rowMatchesFilter({ ...baseRow, model: "a-b" }, { search: "a-b" }));
console.log(rowMatchesFilter({ ...baseRow, model: "a-b" }, { search: "-a-b" }));
