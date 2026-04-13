import { GoogleGenAI } from "@google/genai";

type GoogleGenAIInit = ConstructorParameters<typeof GoogleGenAI>[0] & {
  maxRetries?: number;
};

const RETRYABLE_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);
const RETRYABLE_STATUS_TEXT = new Set([
  "DEADLINE_EXCEEDED",
  "INTERNAL",
  "RESOURCE_EXHAUSTED",
  "UNAVAILABLE",
]);

export interface AIErrorInfo {
  retryable: boolean;
  label: string;
  detail: string;
  statusCode?: number;
  statusText?: string;
  suggestedRetrySeconds?: number;
}

interface ErrorPayload {
  code?: number;
  message?: string;
  status?: string;
}

const getString = (value: unknown): string | undefined => {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const getNumber = (value: unknown): number | undefined => {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const stringifyUnknown = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const compactWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const parseEmbeddedPayload = (message: string): ErrorPayload | null => {
  const firstBrace = message.indexOf("{");
  if (firstBrace === -1) return null;

  try {
    const parsed = JSON.parse(message.slice(firstBrace));
    const payload = typeof parsed?.error === "object" && parsed.error ? parsed.error : parsed;
    return {
      code: getNumber((payload as any)?.code),
      message: getString((payload as any)?.message),
      status: getString((payload as any)?.status),
    };
  } catch {
    return null;
  }
};

const extractStatusText = (message: string): string | undefined => {
  const match = message.match(/got status:\s*([A-Z_]+)/i);
  return match?.[1]?.toUpperCase();
};

const extractRetryDelaySeconds = (message: string): number | undefined => {
  // Look for "Please retry in 6.093s" or "retryDelay": "5s" patterns
  const retryIn = message.match(/retry in\s+([\d.]+)s/i);
  if (retryIn) return parseFloat(retryIn[1]);
  const retryDelay = message.match(/"retryDelay"\s*:\s*"(\d+)s"/);
  if (retryDelay) return parseInt(retryDelay[1], 10);
  return undefined;
};

const extractMessage = (errorObj: any, payload: ErrorPayload | null, fallback: string): string => {
  const candidates = [
    payload?.message,
    getString(errorObj?.error?.message),
    getString(errorObj?.details),
    getString(errorObj?.cause?.message),
    getString(errorObj?.response?.data?.error?.message),
    getString(errorObj?.response?.data?.message),
    getString(errorObj?.response?.statusText),
    fallback,
  ];

  return candidates.find((value): value is string => typeof value === 'string' && value.trim().length > 0) || 'Unknown AI error';
};

export const createAIClient = (apiKey?: string): GoogleGenAI => {
  return new GoogleGenAI({ apiKey, maxRetries: 0 } as GoogleGenAIInit);
};

export const classifyAIError = (error: unknown): AIErrorInfo => {
  const errorObj = error as any;
  const rawMessage = getString(errorObj?.message) || stringifyUnknown(error);
  const payload = parseEmbeddedPayload(rawMessage);
  const statusCode =
    getNumber(errorObj?.status) ||
    getNumber(errorObj?.code) ||
    getNumber(errorObj?.error?.code) ||
    payload?.code;
  const statusText =
    getString(errorObj?.error?.status)?.toUpperCase() ||
    payload?.status?.toUpperCase() ||
    extractStatusText(rawMessage);
  const rawDetail = compactWhitespace(extractMessage(errorObj, payload, rawMessage));
  const errorName = getString(errorObj?.name) || "";

  const isRateLimit =
    statusCode === 429 ||
    statusText === "RESOURCE_EXHAUSTED" ||
    /quota|rate limit|too many requests/i.test(rawDetail);
  const isServiceUnavailable =
    statusCode === 503 || statusText === "UNAVAILABLE";
  const isTimeout =
    statusCode === 408 ||
    statusText === "DEADLINE_EXCEEDED" ||
    errorName === "APIConnectionTimeoutError" ||
    /timed?\s*out|deadline exceeded/i.test(rawDetail);
  const isNetwork =
    errorName === "APIConnectionError" ||
    /fetch failed|network|socket hang up|econnreset|enotfound|connection reset/i.test(rawDetail);
  const isServerError =
    typeof statusCode === "number" && statusCode >= 500;

  const retryable =
    isRateLimit ||
    isServiceUnavailable ||
    isTimeout ||
    isNetwork ||
    (typeof statusCode === "number" && RETRYABLE_STATUS_CODES.has(statusCode)) ||
    (!!statusText && RETRYABLE_STATUS_TEXT.has(statusText));

  let label = "Gemini request failed";
  let detail = rawDetail;
  if (isRateLimit) {
    label = "Gemini is busy right now";
    detail = label;
  } else if (isServiceUnavailable) {
    label = "Gemini is temporarily unavailable";
    detail = label;
  } else if (isTimeout) {
    label = "Gemini request timed out";
    detail = label;
  } else if (isNetwork) {
    label = "Gemini connection failed";
    detail = label;
  } else if (isServerError && statusCode) {
    label = "Gemini server error";
    detail = label;
  } else if (statusCode) {
    label = "Gemini request failed";
  }

  return {
    retryable,
    label,
    detail,
    statusCode,
    statusText,
    suggestedRetrySeconds: retryable ? extractRetryDelaySeconds(rawMessage) : undefined,
  };
};

export const formatAIError = (errorInfo: AIErrorInfo): string => {
  if (!errorInfo.detail || errorInfo.detail === errorInfo.label) {
    return errorInfo.label;
  }
  return `${errorInfo.label}: ${errorInfo.detail}`;
};

export const getAIRetryDelaySeconds = (attempt: number, suggestedSeconds?: number): number => {
  if (suggestedSeconds && suggestedSeconds > 0) {
    // Use Gemini's suggested delay with ±15% jitter
    return suggestedSeconds * (0.85 + Math.random() * 0.3);
  }
  const base = Math.pow(2, Math.min(Math.max(attempt, 1), 6));
  // Add ±25% jitter to stagger concurrent requests (e.g. PvP)
  const jitter = base * (0.75 + Math.random() * 0.5);
  return jitter;
};