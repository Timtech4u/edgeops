import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  InferenceSource,
  type GenerativeModel,
} from 'firebase/ai';
import { app } from './firebase';
import {
  buildOfflineSuggestedReply,
  evaluateNoiseGate,
  scrubPiiLocally,
} from './privacyShield';
import type { IncidentItem, NoiseGateResult, ScrubResult } from '../types/edgeops';

let hybridModelInstance: GenerativeModel | null = null;

export function getFirebaseHybridModel(): GenerativeModel | null {
  if (hybridModelInstance) return hybridModelInstance;
  try {
    const ai = getAI(app, { backend: new GoogleAIBackend() });
    hybridModelInstance = getGenerativeModel(ai, {
      mode: InferenceMode.PREFER_ON_DEVICE,
      inCloudParams: {
        model: 'gemini-3.5-flash-lite',
      },
    });
    return hybridModelInstance;
  } catch {
    return null;
  }
}

export interface OnDeviceCapability {
  chromeGeminiNanoDetected: boolean;
  hybridSdkConfigured: boolean;
  offlineReady: boolean;
  modeLabel: string;
}

export async function detectOnDeviceCapability(): Promise<OnDeviceCapability> {
  let chromeGeminiNanoDetected = false;
  if (typeof window !== 'undefined') {
    const win = window as unknown as Record<string, unknown>;
    if ('LanguageModel' in win && typeof (win.LanguageModel as { availability?: unknown }).availability === 'function') {
      try {
        const availability = await (win.LanguageModel as { availability: () => Promise<string> }).availability();
        chromeGeminiNanoDetected = availability === 'available' || availability === 'readily' || availability === 'downloadable';
      } catch {
        chromeGeminiNanoDetected = false;
      }
    } else if (win.ai && typeof (win.ai as Record<string, unknown>).languageModel === 'object') {
      chromeGeminiNanoDetected = true;
    }
  }

  const hybridSdkConfigured = getFirebaseHybridModel() !== null;

  return {
    chromeGeminiNanoDetected,
    hybridSdkConfigured,
    offlineReady: true,
    modeLabel: chromeGeminiNanoDetected
      ? 'Private · On-Device (Gemini Nano)'
      : 'Hybrid · Local Privacy Shield + Cloud',
  };
}

export interface HybridPrivacyShieldOutput {
  noise: NoiseGateResult;
  scrub: ScrubResult;
  suggestedReply: string;
  inferenceSource: 'on_device' | 'in_cloud';
  engineDescription: string;
}

/**
 * Runs the Privacy Shield locally first (Noise Gate + PII Firewall) at $0 cost and offline.
 * When Chrome's built-in Gemini Nano is available, invokes Firebase AI Logic in PREFER_ON_DEVICE
 * hybrid mode on the already-scrubbed text to polish the customer reply without exposing raw PII.
 */
export async function runHybridPrivacyShield(
  incident: Pick<IncidentItem, 'title' | 'channel' | 'severity' | 'rawPayload'>,
  options: { simulateOffline?: boolean; tryHybridModel?: boolean } = {}
): Promise<HybridPrivacyShieldOutput> {
  const noise = evaluateNoiseGate(incident.title, incident.rawPayload);
  const scrub = scrubPiiLocally(incident.rawPayload);
  let suggestedReply = buildOfflineSuggestedReply(incident, scrub.scrubbedText);
  let inferenceSource: 'on_device' | 'in_cloud' = 'on_device';
  let engineDescription = options.simulateOffline
    ? 'Offline Local Shield · Gemini Nano / Edge Rules ($0)'
    : 'Firebase AI Logic · PREFER_ON_DEVICE ($0)';

  const browserOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
  const shouldAttemptModel = options.tryHybridModel && !options.simulateOffline && browserOnline;

  if (shouldAttemptModel) {
    const model = getFirebaseHybridModel();

    if (model) {
      try {
        const prompt =
          `You are a calm, approachable customer support specialist. Draft a concise 2-sentence customer update ` +
          `based strictly on this PII-scrubbed incident summary. Never ask for sensitive credentials or invent ticket IDs.\n\n` +
          `Title: ${incident.title}\nScrubbed Summary: ${scrub.scrubbedText}`;
        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();
        if (text.length > 20) {
          suggestedReply = text;
        }
        if (result.response.inferenceSource === InferenceSource.IN_CLOUD) {
          inferenceSource = 'in_cloud';
          engineDescription = 'Firebase AI Logic · PREFER_ON_DEVICE (Cloud Fallback)';
        } else {
          inferenceSource = 'on_device';
          engineDescription = 'Firebase AI Logic · On-Device Gemini Nano ($0)';
        }
      } catch {
        // Keep deterministic offline reply so privacy shield never breaks
        inferenceSource = 'on_device';
        engineDescription = 'Offline Local Shield · PREFER_ON_DEVICE ($0)';
      }
    }
  }

  return {
    noise,
    scrub,
    suggestedReply,
    inferenceSource,
    engineDescription,
  };
}

export interface LocalTriageChatParams {
  prompt: string;
  incidentTitle: string;
  channel: string;
  severity: IncidentItem['severity'];
  scrubbedContext: string;
  occurrenceCount: number;
  isDraftReply?: boolean;
  simulateOffline?: boolean;
}

export interface LocalTriageChatResult {
  handledLocally: boolean;
  text: string;
  engine: 'on_device' | 'cloud';
  engineLabel: string;
}

/**
 * Runs Triage Chat strictly on-device when offline OR when Chrome's built-in Gemini Nano
 * is available for quick drafts via Firebase AI Logic (InferenceMode.PREFER_ON_DEVICE).
 * Always operates strictly on locally scrubbed text (zero raw PII).
 */
export async function runLocalTriageChat(
  params: LocalTriageChatParams
): Promise<LocalTriageChatResult | null> {
  const safePrompt = scrubPiiLocally(params.prompt).scrubbedText;
  const safeContext = scrubPiiLocally(params.scrubbedContext).scrubbedText;
  const browserOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
  const isOffline = Boolean(params.simulateOffline || !browserOnline);

  // 1. Run Firebase AI Logic (InferenceMode.PREFER_ON_DEVICE) directly on quick reply drafts
  //    or when Chrome Gemini Nano is natively available offline (automatically uses Nano on-device
  //    and transparently routes to cloud Gemini 3.5 Flash-Lite when Nano isn't installed).
  const capability = await detectOnDeviceCapability();
  if ((capability.chromeGeminiNanoDetected && isOffline) || (!isOffline && params.isDraftReply)) {
    const model = getFirebaseHybridModel();
    if (model) {
      try {
        const nanoPrompt =
          `You are EdgeOps Triage Assistant running privately on-device. ` +
          `Be concise, calm, and practical. Never invent IDs or ask for raw PII.\n\n` +
          `Channel: ${params.channel}\n` +
          `Alert: ${params.incidentTitle} (${params.occurrenceCount} ${params.occurrenceCount === 1 ? 'occurrence' : 'occurrences'})\n` +
          `Scrubbed Context:\n${safeContext}\n\n` +
          `Team Question: ${safePrompt}`;
        const result = await model.generateContent(nanoPrompt);
        const text = result.response.text().trim();
        if (text.length > 0) {
          const isCloud = result.response.inferenceSource === InferenceSource.IN_CLOUD;
          return {
            handledLocally: true,
            text,
            engine: isCloud ? 'cloud' : 'on_device',
            engineLabel: isCloud ? 'Cloud · Hybrid' : 'On-Device · Gemini Nano',
          };
        }
      } catch {
        if (!isOffline) {
          return null;
        }
      }
    }
  }

  // 2. When offline, provide an immediate zero-latency local response on-device
  if (isOffline) {
    const lowerPrompt = safePrompt.toLowerCase();
    const wantsDraft =
      params.isDraftReply ||
      lowerPrompt.includes('draft') ||
      lowerPrompt.includes('customer reply') ||
      lowerPrompt.includes('response');
    const wantsSummary =
      params.occurrenceCount > 1 &&
      (lowerPrompt.includes('summarize') || lowerPrompt.includes('all ') || lowerPrompt.includes('alerts'));

    if (wantsDraft) {
      const reply = buildOfflineSuggestedReply(
        { title: params.incidentTitle, channel: params.channel, severity: params.severity },
        safeContext
      );
      return {
        handledLocally: true,
        text: reply,
        engine: 'on_device',
        engineLabel: 'On-Device · Offline',
      };
    }

    if (wantsSummary) {
      return {
        handledLocally: true,
        text:
          `This thread groups **${params.occurrenceCount} repeated alerts** in ${params.channel} for "${params.incidentTitle}".\n\n` +
          `• **Latest protected summary:** ${safeContext.slice(0, 260)}${safeContext.length > 260 ? '...' : ''}\n` +
          `• **Recommended next step:** Confirm whether the underlying trigger is still firing, assign an owner in ${params.channel}, and reconnect to run a live cloud check if needed.`,
        engine: 'on_device',
        engineLabel: 'On-Device · Offline',
      };
    }

    return {
      handledLocally: true,
      text:
        `Working offline — here is a local on-device triage note for "${params.incidentTitle}" (${params.channel}):\n\n` +
        `• **What we know:** ${safeContext.slice(0, 240)}${safeContext.length > 240 ? '...' : ''}\n` +
        `• **Suggested next step:** Verify impact with the ${params.channel} owner, check for repeated occurrences (${params.occurrenceCount} recorded), and share a status update once confirmed.`,
      engine: 'on_device',
      engineLabel: 'On-Device · Offline',
    };
  }

  return null;
}

export interface LocalWorkspaceChatParams {
  prompt: string;
  workspaceName: string;
  threads: Array<{
    title: string;
    channel: string;
    count: number;
    bucket: 'needs_action' | 'hidden_noise';
    priorityScore: number | null;
    revenueRisk: number | null;
    scrubbedSummary: string;
    resolved: boolean;
    groupKey: string;
    latestId: string;
    needsEngineering: number | null;
    timestampLabel: string;
  }>;
  simulateOffline?: boolean;
  offlineFallbackText: string;
}

/**
 * Runs Workspace Copilot strictly on-device when offline (or via Chrome Gemini Nano when available offline).
 */
export async function runLocalWorkspaceChat(
  params: LocalWorkspaceChatParams
): Promise<LocalTriageChatResult | null> {
  const browserOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
  const isOffline = Boolean(params.simulateOffline || !browserOnline);
  if (!isOffline) return null;

  const safePrompt = scrubPiiLocally(params.prompt).scrubbedText;
  const capability = await detectOnDeviceCapability();
  if (capability.chromeGeminiNanoDetected) {
    const model = getFirebaseHybridModel();
    if (model) {
      try {
        const digest = params.threads
          .slice(0, 10)
          .map(
            (t, idx) =>
              `${idx + 1}. [${t.channel}${t.count > 1 ? ` ×${t.count}` : ''}${t.priorityScore !== null ? ` · ${t.priorityScore}%` : ''}] ${t.title}: ${t.scrubbedSummary.slice(0, 140)}`
          )
          .join('\n');
        const result = await model.generateContent(
          `You are EdgeOps Copilot running privately on-device for ${params.workspaceName}. ` +
            `Answer concisely in plain English with bullet points. Never ask for or output raw PII.\n\n` +
            `Active Workspace Threads:\n${digest}\n\nQuestion: ${safePrompt}`
        );
        const text = result.response.text().trim();
        if (text.length > 0) {
          return {
            handledLocally: true,
            text,
            engine: 'on_device',
            engineLabel: 'On-Device · Gemini Nano',
          };
        }
      } catch {
        // Fall through to deterministic on-device workspace summary
      }
    }
  }

  return {
    handledLocally: true,
    text: params.offlineFallbackText,
    engine: 'on_device',
    engineLabel: 'On-Device · Offline',
  };
}


