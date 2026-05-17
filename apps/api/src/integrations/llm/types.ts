export type ResolvedLlmCredentials = {
  provider: string;
  modelId: string;
  apiKey: string | null;
  baseUrl: string | null;
};
