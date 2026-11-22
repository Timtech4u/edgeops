import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Layers,
  MessageSquare,
  RefreshCw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  WifiOff,
  Wrench,
} from 'lucide-react';
import { formatLatencyDuration, getPriorityBadge, getRouteBadge } from '../lib/decisions';
import { runLocalTriageChat } from '../lib/hybridAi';
import { computeOccurrenceDiffNote, type IncidentGroup } from '../lib/incidentGroups';
import { scrubPiiLocally } from '../lib/privacyShield';
import { formatSlackText } from '../lib/slackSync';
import { humanizeToolName } from '../lib/toolRegistry';
import type { IncidentItem } from '../types/edgeops';

interface TicketDetailPaneProps {
  group: IncidentGroup | null;
  hiddenOnMobile?: boolean;
  onBackToInbox?: () => void;
  totalToolsCount: number;
  isOfflineSimulated: boolean;
  isRefreshingLocal: boolean;
  isInvestigating: boolean;
  investigationError: string | null;
  isSendingSlack: boolean;
  isSyncingSlack: boolean;
  slackConnected: boolean;
  slackTeam?: string;
  slackChannel: string;
  botName: string;
  webhookUrl: string;
  onToggleNoiseStatus: (incidentIds: string[]) => void;
  onRefreshLocalShield: (incidentId: string) => void;
  onRunInvestigation: (incident: IncidentItem) => void;
  onApproveAndFix: (incidentIds: string[], primaryIncident: IncidentItem) => void;
  onSendToSlack: (incident: IncidentItem) => void;
  onSyncSlack: () => Promise<void>;
  onOpenSlackSettings: () => void;
  onOpenConnections: () => void;
}

interface TriageChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  engine?: 'on_device' | 'cloud';
  engineLabel?: string;
  streaming?: boolean;
  error?: boolean;
}

type ActiveMetadataDrawer = 'privacy' | 'triage' | 'tools' | null;

function renderHighlightedBefore(rawPayload: string) {
  const { redactions } = scrubPiiLocally(rawPayload);
  if (redactions.length === 0) {
    return <span>{rawPayload}</span>;
  }

  const parts: Array<{ text: string; redacted: boolean; category?: string }> = [];
  let cursor = 0;
  for (const span of redactions) {
    if (span.start > cursor) {
      parts.push({ text: rawPayload.slice(cursor, span.start), redacted: false });
    }
    parts.push({
      text: rawPayload.slice(span.start, span.end),
      redacted: true,
      category: span.category,
    });
    cursor = span.end;
  }
  if (cursor < rawPayload.length) {
    parts.push({ text: rawPayload.slice(cursor), redacted: false });
  }

  return (
    <>
      {parts.map((part, idx) =>
        part.redacted ? (
          <mark
            key={idx}
            title={`Protected ${part.category}`}
            className="bg-rose-100/90 text-rose-900 rounded px-1 py-0.5 font-mono text-[11px]"
          >
            {part.text}
          </mark>
        ) : (
          <span key={idx}>{part.text}</span>
        )
      )}
    </>
  );
}

function renderHighlightedAfter(scrubbedText: string) {
  const tokenRegex = /(\[Protected (?:Email|Phone|Account|Card)\])/g;
  const segments = scrubbedText.split(tokenRegex);
  return (
    <>
      {segments.map((seg, idx) =>
        /^\[Protected (?:Email|Phone|Account|Card)\]$/.test(seg) ? (
          <span
            key={idx}
            className="inline-block bg-emerald-50 text-emerald-800 border border-emerald-200 rounded px-1.5 py-0.5 font-mono text-[11px]"
          >
            {seg}
          </span>
        ) : (
          <span key={idx}>{seg}</span>
        )
      )}
    </>
  );
}

function renderChatInline(text: string) {
  const tokenRegex = /(\*\*[^*]+\*\*|`[^`]+`|\[Protected (?:Email|Phone|Account|Card)\])/g;
  const parts = text.split(tokenRegex);
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={idx} className="font-semibold text-slate-900">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={idx}
          className="font-mono text-[12px] bg-slate-100 text-slate-800 px-1 py-0.5 rounded"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (/^\[Protected (?:Email|Phone|Account|Card)\]$/.test(part)) {
      return (
        <span
          key={idx}
          className="inline-block bg-emerald-50 text-emerald-800 border border-emerald-200 rounded px-1.5 py-0.5 font-mono text-[11px]"
        >
          {part}
        </span>
      );
    }
    return <span key={idx}>{part}</span>;
  });
}

function renderChatMarkdown(text: string) {
  const lines = text.split('\n');
  return (
    <div className="space-y-1.5">
      {lines.map((rawLine, idx) => {
        const line = rawLine.trim();
        if (!line) {
          return <div key={idx} className="h-1" />;
        }
        const headingMatch = line.match(/^#{1,4}\s+(.*)$/);
        if (headingMatch) {
          return (
            <p key={idx} className="font-semibold text-slate-900 pt-1 leading-snug">
              {renderChatInline(headingMatch[1].replace(/^\*\*(.*)\*\*$/, '$1'))}
            </p>
          );
        }
        const bulletMatch = line.match(/^[-*•]\s+(.*)$/);
        if (bulletMatch) {
          return (
            <div key={idx} className="flex items-start gap-2 pl-1">
              <span className="mt-2 w-1 h-1 rounded-full bg-slate-400 shrink-0" aria-hidden="true" />
              <span className="leading-relaxed">{renderChatInline(bulletMatch[1])}</span>
            </div>
          );
        }
        const numberedMatch = line.match(/^(\d+\.)\s+(.*)$/);
        if (numberedMatch) {
          return (
            <div key={idx} className="flex items-start gap-2 pl-1">
              <span className="text-xs font-medium text-slate-500 tabular-nums pt-0.5 shrink-0">
                {numberedMatch[1]}
              </span>
              <span className="leading-relaxed">{renderChatInline(numberedMatch[2])}</span>
            </div>
          );
        }
        return (
          <p key={idx} className="leading-relaxed">
            {renderChatInline(line)}
          </p>
        );
      })}
    </div>
  );
}

function formatOccurrenceTime(item: IncidentItem): string {
  const ms = Date.parse(item.createdAtIso);
  if (!Number.isFinite(ms)) return item.timestampLabel;
  try {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return item.timestampLabel;
  }
}

export function TicketDetailPane({
  group,
  hiddenOnMobile = false,
  onBackToInbox,
  totalToolsCount,
  isOfflineSimulated,
  isRefreshingLocal,
  isInvestigating,
  investigationError,
  isSendingSlack,
  isSyncingSlack,
  slackConnected,
  slackTeam,
  slackChannel,
  botName,
  webhookUrl,
  onToggleNoiseStatus,
  onRefreshLocalShield,
  onRunInvestigation,
  onApproveAndFix,
  onSendToSlack,
  onSyncSlack,
  onOpenSlackSettings,
  onOpenConnections,
}: TicketDetailPaneProps) {
  const incident = group?.latest ?? null;
  const groupKey = group?.groupKey ?? '';

  const [openDrawer, setOpenDrawer] = useState<ActiveMetadataDrawer>(null);
  const [occurrencesOpen, setOccurrencesOpen] = useState(false);
  const [expandedTraceName, setExpandedTraceName] = useState<string | null>(null);
  const [showTechTraceName, setShowTechTraceName] = useState<string | null>(null);
  const [copiedWebhook, setCopiedWebhook] = useState(false);
  const [showWebhookUrl, setShowWebhookUrl] = useState(false);

  // Per-thread streaming Triage Chat state
  const [chatByGroup, setChatByGroup] = useState<Record<string, TriageChatMessage[]>>({});
  const [chatInput, setChatInput] = useState('');
  const [isStreamingChat, setIsStreamingChat] = useState(false);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setOpenDrawer(null);
    setOccurrencesOpen(false);
    setExpandedTraceName(null);
    setShowTechTraceName(null);
    setChatInput('');
    if (chatAbortRef.current) {
      chatAbortRef.current.abort();
      chatAbortRef.current = null;
      setIsStreamingChat(false);
    }
  }, [groupKey]);

  useEffect(() => {
    return () => {
      chatAbortRef.current?.abort();
    };
  }, []);

  const currentMessages = useMemo(
    () => (groupKey ? chatByGroup[groupKey] || [] : []),
    [chatByGroup, groupKey]
  );

  useEffect(() => {
    if (currentMessages.length > 0) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [currentMessages.length, isStreamingChat]);

  const cleanRawPayload = useMemo(
    () => (incident ? formatSlackText(incident.rawPayload) || incident.rawPayload : ''),
    [incident]
  );

  const scrubPreview = useMemo(
    () => (incident ? scrubPiiLocally(cleanRawPayload) : null),
    [incident, cleanRawPayload]
  );

  const handleCopyWebhook = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
    } catch {
      // Visual confirmation fallback
    }
    setCopiedWebhook(true);
    setTimeout(() => setCopiedWebhook(false), 2000);
  };

  const handleCopyMessage = async (msgId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Visual confirmation fallback
    }
    setCopiedMsgId(msgId);
    setTimeout(() => setCopiedMsgId((curr) => (curr === msgId ? null : curr)), 2000);
  };

  const handleStopStreaming = () => {
    if (chatAbortRef.current) {
      chatAbortRef.current.abort();
      chatAbortRef.current = null;
    }
    setIsStreamingChat(false);
    if (!groupKey) return;
    setChatByGroup((prev) => ({
      ...prev,
      [groupKey]: (prev[groupKey] || []).map((m) =>
        m.streaming ? { ...m, streaming: false } : m
      ),
    }));
  };

  const handleSendChat = async (
    rawPrompt: string,
    options: { isDraftReply?: boolean } = {}
  ) => {
    const trimmed = rawPrompt.trim();
    if (!trimmed || !group || !incident || !scrubPreview || isStreamingChat) return;

    const targetGroupKey = group.groupKey;
    const safeUserText = scrubPiiLocally(trimmed).scrubbedText;
    const userMsgId = `u_${Date.now().toString(36)}`;
    const assistantMsgId = `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;

    const priorHistory = (chatByGroup[targetGroupKey] || [])
      .filter((m) => !m.error && m.text.trim().length > 0)
      .slice(-6)
      .map((m) => ({ role: m.role, text: m.text }));

    setChatInput('');
    setChatByGroup((prev) => ({
      ...prev,
      [targetGroupKey]: [
        ...(prev[targetGroupKey] || []),
        { id: userMsgId, role: 'user', text: trimmed },
        {
          id: assistantMsgId,
          role: 'assistant',
          text: '',
          engine: isOfflineSimulated ? 'on_device' : 'cloud',
          engineLabel: isOfflineSimulated ? 'On-Device' : 'Cloud · Streaming',
          streaming: true,
        },
      ],
    }));
    setIsStreamingChat(true);

    // 1. Offline or Chrome Gemini Nano local path via Firebase AI Logic Hybrid Inference
    const localResult = await runLocalTriageChat({
      prompt: safeUserText,
      incidentTitle: incident.title,
      channel: incident.channel,
      severity: incident.severity,
      scrubbedContext: scrubPreview.scrubbedText,
      occurrenceCount: group.count,
      isDraftReply: options.isDraftReply,
      simulateOffline: isOfflineSimulated,
    });

    if (localResult?.handledLocally) {
      setChatByGroup((prev) => ({
        ...prev,
        [targetGroupKey]: (prev[targetGroupKey] || []).map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                text: localResult.text,
                engine: localResult.engine,
                engineLabel: localResult.engineLabel,
                streaming: false,
              }
            : m
        ),
      }));
      setIsStreamingChat(false);
      return;
    }

    // 2. Ultra-fast Cloud SSE streaming via POST /api/chat (ONLY locally scrubbed context!)
    const controller = new AbortController();
    chatAbortRef.current = controller;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          message: safeUserText,
          history: priorHistory,
          ticket: {
            title: scrubPiiLocally(formatSlackText(incident.title) || incident.title).scrubbedText,
            channel: incident.channel,
            severity: incident.severity,
            scrubbedSummary: scrubPreview.scrubbedText,
            occurrenceCount: group.count,
            occurrences: group.occurrences.slice(0, 10).map((occ) => ({
              timestampLabel: occ.timestampLabel,
              createdAtIso: occ.createdAtIso,
              scrubbedSummary: scrubPiiLocally(
                formatSlackText(occ.scrubbedSummary) || occ.scrubbedSummary
              ).scrubbedText,
            })),
            diagnosis: incident.investigation?.diagnosis,
            remediationPlan: incident.investigation?.remediationPlan,
          },
        }),
      });

      if (!response.ok || !response.body) {
        const errText = await response.text().catch(() => '');
        throw new Error(errText || `Chat stream failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';
      let streamError: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const dataLines = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim());
          if (dataLines.length === 0) continue;

          try {
            const payload = JSON.parse(dataLines.join('\n')) as {
              type?: string;
              text?: string;
              model?: string;
              error?: string;
            };
            if (payload.type === 'delta' && typeof payload.text === 'string') {
              accumulated += payload.text;
              const nextText = accumulated;
              setChatByGroup((prev) => ({
                ...prev,
                [targetGroupKey]: (prev[targetGroupKey] || []).map((m) =>
                  m.id === assistantMsgId
                    ? {
                        ...m,
                        text: nextText,
                        engine: 'cloud',
                        engineLabel: 'Cloud · Streaming',
                        streaming: true,
                      }
                    : m
                ),
              }));
            } else if (payload.type === 'error') {
              streamError = payload.error || 'Unable to stream reply right now.';
            }
          } catch {
            // ignore partial SSE JSON
          }
        }
      }

      setChatByGroup((prev) => ({
        ...prev,
        [targetGroupKey]: (prev[targetGroupKey] || []).map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                text:
                  accumulated.trim().length > 0
                    ? accumulated
                    : streamError || 'No response received. Please try again.',
                error: accumulated.trim().length === 0,
                streaming: false,
              }
            : m
        ),
      }));
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        return;
      }
      const msg = err instanceof Error ? err.message : 'Unable to reach triage chat.';
      setChatByGroup((prev) => ({
        ...prev,
        [targetGroupKey]: (prev[targetGroupKey] || []).map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                text: m.text.trim().length > 0 ? m.text : msg,
                error: m.text.trim().length === 0,
                streaming: false,
              }
            : m
        ),
      }));
    } finally {
      if (chatAbortRef.current === controller) {
        chatAbortRef.current = null;
      }
      setIsStreamingChat(false);
    }
  };

  if (!group || !incident || !scrubPreview) {
    const cleanBotName = (botName || 'EdgeOps').replace(/^@/, '');
    return (
      <section
        aria-label="Workspace overview"
        className={`${
          hiddenOnMobile ? 'hidden min-[900px]:flex' : 'flex'
        } flex-1 bg-[#F8FAFC] items-center justify-center p-6 sm:p-10 min-[900px]:h-full overflow-y-auto`}
      >
        <div className="w-full max-w-lg bg-white border border-[#E2E8F0] rounded-2xl p-8 space-y-6">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="w-9 h-9 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] flex items-center justify-center text-slate-700">
                <MessageSquare className="w-4 h-4" />
              </div>

              {slackConnected && slackTeam ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    Connected to {slackTeam} as @{cleanBotName}
                  </span>
                </span>
              ) : (
                <span className="text-xs text-slate-400">Slack not connected</span>
              )}
            </div>

            <div>
              <h1 className="font-display text-xl font-semibold text-slate-900 tracking-tight">
                Waiting for your first Slack message
              </h1>
              <p className="text-sm text-slate-500 mt-1.5 leading-relaxed">
                Invite your bot to any channel with{' '}
                <code className="font-mono text-xs text-slate-800 bg-slate-100 px-1.5 py-0.5 rounded">
                  /invite @{cleanBotName}
                </code>
                . Personal customer details stay private on your device before any checks run.
              </p>
            </div>
          </div>

          {/* Real Primary Action */}
          <div className="flex flex-wrap items-center gap-3">
            {slackConnected ? (
              <button
                type="button"
                data-testid="empty-state-sync-slack-btn"
                disabled={isSyncingSlack || isOfflineSimulated}
                onClick={() => void onSyncSlack()}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap"
              >
                <RefreshCw className={`w-4 h-4 ${isSyncingSlack ? 'animate-spin' : ''}`} />
                <span>{isSyncingSlack ? 'Syncing channels...' : 'Sync Slack channels'}</span>
              </button>
            ) : (
              <button
                type="button"
                data-testid="empty-state-connect-slack-btn"
                onClick={onOpenSlackSettings}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap"
              >
                <span>Connect Slack</span>
              </button>
            )}

            <button
              type="button"
              onClick={onOpenConnections}
              className="inline-flex items-center justify-center px-4 py-2.5 text-sm font-medium text-slate-700 bg-white border border-[#E2E8F0] hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap"
            >
              Manage connections
            </button>
          </div>

          {/* Quiet Webhook URL disclosure */}
          <div className="pt-3 border-t border-slate-100 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setShowWebhookUrl((prev) => !prev)}
                aria-expanded={showWebhookUrl}
                className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800 transition-colors"
              >
                {showWebhookUrl ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
                <span>Webhook URL</span>
              </button>
              <button
                type="button"
                onClick={handleCopyWebhook}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
              >
                {copiedWebhook ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedWebhook ? 'Copied' : 'Copy URL'}</span>
              </button>
            </div>
            {showWebhookUrl && (
              <div
                data-testid="empty-state-webhook-url"
                className="px-3 py-2 rounded-lg bg-[#F8FAFC] border border-[#E2E8F0] font-mono text-xs text-slate-700 break-all"
              >
                {webhookUrl}
              </div>
            )}
          </div>
        </div>
      </section>
    );
  }

  const inv = incident.investigation;
  const isResolved = group.occurrences.every((occ) => occ.status === 'resolved');
  const groupIds = group.occurrences.map((occ) => occ.id);
  const decisionScores = group.decisionScores ?? incident.decisionScores;
  const routeBadge = getRouteBadge(decisionScores);
  const priorityBadge = getPriorityBadge({
    bucket: group.bucket,
    isNoise: group.bucket === 'hidden_noise',
    priorityScore: group.priorityScore,
    decisionScores,
  });
  const hasConnectedTools = totalToolsCount > 0 || Boolean(inv && inv.toolTraces.length > 0);
  const toggleDrawer = (target: ActiveMetadataDrawer) => {
    setOpenDrawer((curr) => (curr === target ? null : target));
  };

  return (
    <section
      aria-label="Message details"
      className={`${
        hiddenOnMobile ? 'hidden min-[900px]:block' : 'block'
      } flex-1 bg-white min-[900px]:h-full overflow-y-auto`}
    >
      {/* Clean Narrow-Viewport Back Navigation (< 900px) */}
      {onBackToInbox && (
        <div className="min-[900px]:hidden sticky top-0 z-10 bg-white/95 backdrop-blur-xs border-b border-[#E2E8F0] px-4 py-2.5 flex items-center justify-between">
          <button
            type="button"
            data-testid="mobile-back-to-inbox"
            onClick={onBackToInbox}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 hover:text-slate-900"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Inbox</span>
          </button>
          <span className="text-xs text-slate-400 truncate max-w-[55%]">{incident.channel}</span>
        </div>
      )}

      <div className="max-w-3xl mx-auto px-5 sm:px-9 py-6 sm:py-7 space-y-4">
        {/* 1. Calm Shared-Inbox Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className="font-medium text-slate-700">{incident.channel}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{incident.timestampLabel}</span>
              {incident.isBot && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-600 border border-slate-200/80">
                  bot
                </span>
              )}
              {routeBadge && (
                <span
                  data-testid="detail-route-pill"
                  className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold border whitespace-nowrap ${
                    routeBadge.route === 'page_eng'
                      ? 'bg-rose-50 text-rose-700 border-rose-200'
                      : routeBadge.route === 'notify_ops'
                        ? 'bg-blue-50 text-blue-700 border-blue-200'
                        : 'bg-slate-100 text-slate-600 border-slate-200/80'
                  }`}
                >
                  {routeBadge.shortLabel}
                </span>
              )}
              {incident.replyCount === 0 && (incident.source === 'slack_live' || incident.isBot) && (
                <span className="text-[11px] text-amber-700 font-medium">
                  · No reply in Slack
                </span>
              )}
              {group.count > 1 && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-semibold tabular-nums bg-slate-100 text-slate-700 border border-slate-200/80">
                  ×{group.count} alerts
                </span>
              )}
              {isResolved && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-emerald-700 font-medium">Resolved</span>
                </>
              )}
              {group.bucket === 'hidden_noise' && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-slate-500">Filtered noise</span>
                </>
              )}
            </div>

            <h1 className="font-display text-xl sm:text-2xl font-semibold text-slate-900 tracking-tight leading-snug">
              {(formatSlackText(incident.title) || incident.title).replace(/\n+/g, ' ').trim()}
            </h1>
          </div>

          <div className="shrink-0 flex items-center gap-2 pt-0.5">
            {!isResolved ? (
              <button
                type="button"
                data-testid="header-resolve-btn"
                onClick={() => onApproveAndFix(groupIds, incident)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-[#E2E8F0] hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap"
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                <span>Resolve</span>
              </button>
            ) : (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200/80 whitespace-nowrap">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Resolved</span>
              </span>
            )}
          </div>
        </div>

        {/* Offline / Error Callouts (Only shown when active) */}
        {isOfflineSimulated && (
          <div className="px-4 py-2.5 rounded-xl bg-amber-50/70 border border-amber-200/80 flex items-center gap-2.5 text-xs text-amber-900">
            <WifiOff className="w-4 h-4 text-amber-700 shrink-0" />
            <span>
              Working offline. Privacy protection and Triage Chat run locally on your device.
            </span>
          </div>
        )}

        {investigationError && (
          <div
            role="alert"
            className="px-4 py-2.5 rounded-xl bg-rose-50 border border-rose-200 flex items-start gap-2.5 text-xs text-rose-900"
          >
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            <span>{investigationError}</span>
          </div>
        )}

        {/* 2. Incoming Message Card (Latest Occurrence) + Collapsible N Occurrences Timeline */}
        <div className="rounded-2xl bg-[#F8FAFC] border border-[#E2E8F0] overflow-hidden">
          <div className="p-4 sm:p-5 space-y-2.5">
            <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-6 h-6 rounded-full bg-white border border-[#E2E8F0] text-slate-600 flex items-center justify-center text-[11px] font-semibold shrink-0">
                  {incident.channel.replace(/^#/, '').slice(0, 1).toUpperCase() || 'M'}
                </span>
                <span className="font-medium text-slate-700 truncate">
                  {group.count > 1 ? 'Latest occurrence' : 'Incoming message'}
                </span>
                <span aria-hidden="true">·</span>
                <span className="truncate">{incident.channel}</span>
              </div>
              <span className="text-[11px] text-slate-400 tabular-nums shrink-0">
                {formatOccurrenceTime(incident)}
              </span>
            </div>

            <p className="text-[15px] text-slate-800 leading-relaxed pl-8 whitespace-pre-line break-words">
              {renderHighlightedAfter(scrubPreview.scrubbedText)}
            </p>
          </div>

          {/* Collapsible N Occurrences Timeline when grouped */}
          {group.count > 1 && (
            <div className="border-t border-[#E2E8F0] bg-white/70">
              <button
                type="button"
                data-testid="occurrences-toggle"
                aria-expanded={occurrencesOpen}
                onClick={() => setOccurrencesOpen((prev) => !prev)}
                className="w-full px-4 sm:px-5 py-2.5 flex items-center justify-between gap-2 text-xs font-medium text-slate-600 hover:text-slate-900 transition-colors"
              >
                <span className="inline-flex items-center gap-1.5 tabular-nums">
                  <Layers className="w-3.5 h-3.5 text-slate-400" />
                  <span>{group.count} occurrences</span>
                  <span className="text-slate-400 font-normal">
                    · Showing latest first
                  </span>
                </span>
                {occurrencesOpen ? (
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                )}
              </button>

              {occurrencesOpen && (
                <div
                  data-testid="occurrences-timeline"
                  className="px-4 sm:px-5 pb-3.5 pt-1 border-t border-slate-100 divide-y divide-slate-100"
                >
                  {group.occurrences.map((occ, idx) => {
                    const diffNote = computeOccurrenceDiffNote(occ, group.occurrences[idx + 1]);
                    return (
                      <div
                        key={occ.id}
                        className="py-2 flex items-start justify-between gap-3 text-xs"
                      >
                        <div className="min-w-0 flex items-start gap-2">
                          <span
                            className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                              idx === 0 ? 'bg-blue-600' : 'bg-slate-300'
                            }`}
                            aria-hidden="true"
                          />
                          <div className="min-w-0">
                            <span className="text-slate-700 leading-snug break-words">
                              {diffNote}
                            </span>
                            {idx === 0 && (
                              <span className="ml-1.5 text-[10px] font-medium text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded-full">
                                Latest
                              </span>
                            )}
                          </div>
                        </div>
                        <span className="text-[11px] text-slate-400 tabular-nums shrink-0 whitespace-nowrap">
                          {formatOccurrenceTime(occ)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 3. Single Lightweight Metadata Strip (Replaces the 4 heavy stacked accordions) */}
        <div className="space-y-2.5">
          <div
            data-testid="ticket-metadata-strip"
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              {/* Privacy Shield Chip */}
              <button
                type="button"
                data-testid="chip-privacy"
                aria-expanded={openDrawer === 'privacy'}
                onClick={() => toggleDrawer('privacy')}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors whitespace-nowrap ${
                  openDrawer === 'privacy'
                    ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                    : 'bg-white text-slate-700 border-[#E2E8F0] hover:bg-slate-50'
                }`}
              >
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span className="tabular-nums">
                  {scrubPreview.redactionCount > 0
                    ? `${scrubPreview.redactionCount} ${scrubPreview.redactionCount === 1 ? 'detail' : 'details'} hidden`
                    : 'Private'}
                </span>
              </button>

              {/* Priority / Gemini Decisions Triage Chip */}
              <button
                type="button"
                data-testid="chip-triage"
                aria-expanded={openDrawer === 'triage'}
                onClick={() => toggleDrawer('triage')}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors whitespace-nowrap tabular-nums ${
                  openDrawer === 'triage'
                    ? 'bg-slate-900 text-white border-slate-900'
                    : priorityBadge?.tone === 'urgent'
                      ? 'bg-rose-50 text-rose-700 border-rose-200/90 hover:bg-rose-100/70'
                      : priorityBadge?.tone === 'action'
                        ? 'bg-amber-50 text-amber-800 border-amber-200/90 hover:bg-amber-100/70'
                        : 'bg-white text-slate-600 border-[#E2E8F0] hover:bg-slate-50'
                }`}
              >
                <SlidersHorizontal className="w-3 h-3 shrink-0" />
                <span>{priorityBadge ? priorityBadge.label : 'Triage scores'}</span>
              </button>

              {/* Connected Tools Chip — ONLY shown when workspace has >= 1 real tool connected */}
              {hasConnectedTools && (
                <button
                  type="button"
                  data-testid="chip-tools"
                  aria-expanded={openDrawer === 'tools'}
                  onClick={() => toggleDrawer('tools')}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors whitespace-nowrap tabular-nums ${
                    openDrawer === 'tools'
                      ? 'bg-blue-50 text-blue-800 border-blue-300'
                      : 'bg-white text-slate-700 border-[#E2E8F0] hover:bg-slate-50'
                  }`}
                >
                  <Wrench className="w-3 h-3 text-slate-500 shrink-0" />
                  <span>
                    {inv && inv.toolsUsed.length > 0
                      ? `Tools · ${inv.toolsUsed.length}/${inv.toolsTotal}`
                      : `Tools (${totalToolsCount})`}
                  </span>
                </button>
              )}
            </div>

            <button
              type="button"
              data-testid="toggle-noise-btn"
              onClick={() => onToggleNoiseStatus(groupIds)}
              className="text-xs font-medium text-slate-400 hover:text-slate-700 transition-colors whitespace-nowrap"
            >
              {group.bucket === 'hidden_noise' ? 'Restore to inbox' : 'Mark as noise'}
            </button>
          </div>

          {/* Inline Drawer: Privacy Diff */}
          {openDrawer === 'privacy' && (
            <div
              data-testid="pii-before-after"
              className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-4 space-y-3"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="rounded-lg border border-[#E2E8F0] bg-white p-3 space-y-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-medium text-slate-700">Original (stays on device)</span>
                    <span className="text-rose-700">Private</span>
                  </div>
                  <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-line break-words">
                    {renderHighlightedBefore(cleanRawPayload)}
                  </p>
                </div>

                <div className="rounded-lg border border-emerald-200/80 bg-emerald-50/40 p-3 space-y-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-medium text-emerald-900">Shared safely</span>
                    <span className="text-emerald-700">Safe for chat & checks</span>
                  </div>
                  <p className="text-xs text-slate-800 leading-relaxed whitespace-pre-line break-words">
                    {renderHighlightedAfter(scrubPreview.scrubbedText)}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                <span>
                  Privacy Shield: <span className="text-slate-700">{incident.noiseReason}</span>
                </span>
                <button
                  type="button"
                  disabled={isRefreshingLocal}
                  onClick={() => onRefreshLocalShield(incident.id)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingLocal ? 'animate-spin' : ''}`} />
                  <span>{isRefreshingLocal ? 'Checking...' : 'Re-check on device'}</span>
                </button>
              </div>
            </div>
          )}

          {/* Inline Drawer: 6-Signal Gemini Decisions Breakdown & Explicit Route */}
          {openDrawer === 'triage' && (
            <div
              data-testid="decision-scores-panel"
              className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-4 space-y-3"
            >
              {decisionScores ? (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {[
                      {
                        label: 'Customer blocked',
                        value: decisionScores.customerBlocked ?? 0,
                        barClass:
                          (decisionScores.customerBlocked ?? 0) >= 0.7
                            ? 'bg-rose-500'
                            : (decisionScores.customerBlocked ?? 0) >= 0.45
                              ? 'bg-amber-500'
                              : 'bg-slate-400',
                      },
                      {
                        label: 'Needs action',
                        value: decisionScores.needsAction,
                        barClass:
                          decisionScores.needsAction >= 0.75
                            ? 'bg-rose-500'
                            : decisionScores.needsAction >= 0.55
                              ? 'bg-amber-500'
                              : 'bg-slate-400',
                      },
                      {
                        label: 'Revenue / SLA risk',
                        value: decisionScores.revenueRisk,
                        barClass:
                          decisionScores.revenueRisk >= 0.75
                            ? 'bg-rose-500'
                            : decisionScores.revenueRisk >= 0.5
                              ? 'bg-amber-500'
                              : 'bg-slate-400',
                      },
                      {
                        label: 'Manual money move',
                        value: decisionScores.manualMoneyMove ?? 0,
                        barClass:
                          (decisionScores.manualMoneyMove ?? 0) >= 0.65
                            ? 'bg-amber-500'
                            : 'bg-slate-400',
                      },
                      {
                        label: 'Engineering needed',
                        value: decisionScores.needsEngineering,
                        barClass:
                          decisionScores.needsEngineering >= 0.65
                            ? 'bg-blue-600'
                            : decisionScores.needsEngineering >= 0.4
                              ? 'bg-blue-400'
                              : 'bg-slate-400',
                      },
                      {
                        label: 'Routine FYI',
                        value: decisionScores.isNoise,
                        barClass: 'bg-slate-400',
                      },
                    ].map((metric) => {
                      const pct = Math.max(0, Math.min(100, Math.round(metric.value * 100)));
                      return (
                        <div key={metric.label} className="space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-medium text-slate-700">{metric.label}</span>
                            <span className="tabular-nums text-slate-600 font-medium">{pct}%</span>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-slate-200/80 overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${metric.barClass}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 pt-1.5 border-t border-slate-200/70">
                    <span>
                      Scored by <span className="font-mono text-slate-600">{decisionScores.model}</span>
                      {routeBadge && (
                        <>
                          {' · '}
                          <span className="font-mono text-slate-700">{routeBadge.route}</span>
                        </>
                      )}
                    </span>
                    <span className="tabular-nums">
                      {decisionScores.latencyMs
                        ? `${formatLatencyDuration(decisionScores.latencyMs)} · `
                        : ''}
                      {decisionScores.outputTokens} output tokens
                    </span>
                  </div>
                </>
              ) : (
                <p className="text-xs text-slate-500 leading-relaxed">
                  Incoming Slack messages are automatically scored across 6 signals (customer blocked, action needed, revenue risk, manual money move, engineering need, routine FYI) at 0 output tokens.
                </p>
              )}
            </div>
          )}

          {/* Inline Drawer: Connected MCP / OpenAPI Tools (only when >= 1 tool connected) */}
          {openDrawer === 'tools' && hasConnectedTools && (
            <div
              data-testid="connected-tools-drawer"
              className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-4 space-y-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-slate-600">
                  {inv && inv.toolTraces.length > 0
                    ? `Checked ${inv.toolsUsed.length} of ${inv.toolsTotal} connected tools.`
                    : `${totalToolsCount} connected ${totalToolsCount === 1 ? 'tool' : 'tools'} ready for smart diagnostic checks.`}
                </p>
                <button
                  type="button"
                  data-testid="run-smart-checks-btn"
                  disabled={isInvestigating || isOfflineSimulated}
                  onClick={() => onRunInvestigation(incident)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-500 rounded-lg transition-colors whitespace-nowrap"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{isInvestigating ? 'Checking...' : inv ? 'Re-run checks' : 'Run smart checks'}</span>
                </button>
              </div>

              {inv && inv.toolTraces.length > 0 && (
                <div className="divide-y divide-slate-100 border border-[#E2E8F0] rounded-lg overflow-hidden bg-white">
                  {inv.toolTraces.map((trace) => {
                    const isTraceOpen = expandedTraceName === trace.toolName;
                    const isTechOpen = showTechTraceName === trace.toolName;
                    const friendlyTitle = humanizeToolName(trace.toolName);
                    const matchedScore = inv.toolScores?.find((s) => s.toolName === trace.toolName);
                    return (
                      <div key={trace.toolName}>
                        <button
                          type="button"
                          onClick={() => {
                            setExpandedTraceName(isTraceOpen ? null : trace.toolName);
                            if (isTraceOpen && isTechOpen) setShowTechTraceName(null);
                          }}
                          aria-expanded={isTraceOpen}
                          className="w-full px-3.5 py-2.5 flex items-center justify-between gap-3 text-left hover:bg-[#F8FAFC] transition-colors"
                        >
                          <div className="min-w-0 flex items-center gap-2">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                            <span className="text-xs font-medium text-slate-900 truncate">
                              {friendlyTitle}
                            </span>
                          </div>
                          <span className="text-[11px] text-slate-400 shrink-0 tabular-nums">
                            {matchedScore
                              ? `${Math.round(matchedScore.score * 100)}% match · ${trace.source}`
                              : trace.source}
                          </span>
                        </button>

                        {isTraceOpen && (
                          <div className="px-3.5 pb-3 pt-2 space-y-2 bg-[#F8FAFC] border-t border-slate-100">
                            <p className="text-xs text-slate-700 leading-relaxed">{trace.summary}</p>
                            <div>
                              <button
                                type="button"
                                data-testid="technical-details-toggle"
                                onClick={() =>
                                  setShowTechTraceName(isTechOpen ? null : trace.toolName)
                                }
                                aria-expanded={isTechOpen}
                                className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-slate-800"
                              >
                                {isTechOpen ? (
                                  <ChevronDown className="w-3 h-3" />
                                ) : (
                                  <ChevronRight className="w-3 h-3" />
                                )}
                                <span>Technical details</span>
                              </button>
                              {isTechOpen && (
                                <div className="mt-2 space-y-1.5">
                                  <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-slate-500">
                                    <span>{trace.toolName}</span>
                                    <span>·</span>
                                    <span className="tabular-nums">{trace.latencyMs}ms</span>
                                  </div>
                                  <pre className="p-2 rounded-lg bg-white border border-[#E2E8F0] font-mono text-[11px] text-slate-600 overflow-x-auto">
                                    {JSON.stringify(trace.data, null, 2)}
                                  </pre>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 4. Ultra-Fast Streaming Triage Chat (Intercom / Linear Copilot feel) */}
        <div
          data-testid="triage-chat-panel"
          className="rounded-2xl bg-white border border-[#E2E8F0] flex flex-col overflow-hidden"
        >
          {/* Compact Copilot Header */}
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Sparkles className="w-4 h-4 text-blue-600 shrink-0" />
              <h2 className="text-sm font-semibold text-slate-900">Triage Chat</h2>
              <span
                data-testid="triage-chat-mode-chip"
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border whitespace-nowrap ${
                  isOfflineSimulated
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200/80'
                    : 'bg-[#F8FAFC] text-slate-600 border-[#E2E8F0]'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    isOfflineSimulated ? 'bg-emerald-500' : 'bg-blue-500'
                  }`}
                  aria-hidden="true"
                />
                <span>{isOfflineSimulated ? 'On-Device' : 'Cloud · Streaming'}</span>
              </span>
            </div>

            {currentMessages.length > 0 && !isStreamingChat && (
              <button
                type="button"
                onClick={() =>
                  setChatByGroup((prev) => ({
                    ...prev,
                    [group.groupKey]: [],
                  }))
                }
                className="text-xs text-slate-400 hover:text-slate-700 transition-colors"
              >
                Clear
              </button>
            )}
          </div>

          {/* Quick 1-Click Prompt Chips */}
          <div className="px-4 pt-3 pb-2 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-testid="quick-prompt-explain"
              disabled={isStreamingChat}
              onClick={() =>
                void handleSendChat(
                  'Explain what happened in plain English and give the single clearest next step.'
                )
              }
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 bg-[#F8FAFC] border border-[#E2E8F0] hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50 transition-colors"
            >
              Explain &amp; next step
            </button>

            <button
              type="button"
              data-testid="quick-prompt-draft"
              disabled={isStreamingChat}
              onClick={() =>
                void handleSendChat(
                  'Draft a calm, concise customer reply based on this protected alert.',
                  { isDraftReply: true }
                )
              }
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 bg-[#F8FAFC] border border-[#E2E8F0] hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50 transition-colors"
            >
              Draft customer reply
            </button>

            {group.count > 1 && (
              <button
                type="button"
                data-testid="quick-prompt-summarize-group"
                disabled={isStreamingChat}
                onClick={() =>
                  void handleSendChat(
                    `Summarize all ${group.count} grouped alerts in this thread, highlight what changed across occurrences, and recommend the immediate next step.`
                  )
                }
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-blue-700 bg-blue-50/70 border border-blue-200/80 hover:bg-blue-100/70 disabled:opacity-50 transition-colors"
              >
                Summarize all {group.count} alerts
              </button>
            )}
          </div>

          {/* Streaming Chat Thread */}
          <div className="px-4 py-2.5 space-y-3">
            {currentMessages.length === 0 ? (
              <p className="text-xs text-slate-400 py-1.5 leading-relaxed">
                Pick a quick action above or ask anything about this alert. Personal details stay protected on your device.
              </p>
            ) : (
              currentMessages.map((msg) =>
                msg.role === 'user' ? (
                  <div key={msg.id} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-slate-900 text-white px-3.5 py-2 text-xs leading-relaxed">
                      {msg.text}
                    </div>
                  </div>
                ) : (
                  <div
                    key={msg.id}
                    data-testid="triage-chat-assistant-msg"
                    className="rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] px-4 py-3 space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-medium text-slate-500">
                        {msg.engineLabel || (msg.engine === 'on_device' ? 'On-Device' : 'Cloud · Streaming')}
                      </span>
                      {!msg.streaming && msg.text.trim().length > 0 && !msg.error && (
                        <button
                          type="button"
                          data-testid="chat-copy-btn"
                          onClick={() => void handleCopyMessage(msg.id, msg.text)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium text-slate-600 hover:text-slate-900 hover:bg-white border border-transparent hover:border-[#E2E8F0] transition-colors"
                        >
                          {copiedMsgId === msg.id ? (
                            <>
                              <Check className="w-3 h-3 text-emerald-600" />
                              <span className="text-emerald-700">Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3" />
                              <span>Copy</span>
                            </>
                          )}
                        </button>
                      )}
                    </div>

                    <div
                      className={`text-sm break-words ${
                        msg.error ? 'text-rose-700' : 'text-slate-800'
                      }`}
                    >
                      {msg.text ? (
                        <div>
                          {renderChatMarkdown(msg.text)}
                          {msg.streaming && (
                            <span
                              className="inline-block w-1.5 h-3.5 mt-1 align-middle bg-blue-600 animate-pulse rounded-xs"
                              aria-hidden="true"
                            />
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">Thinking...</span>
                      )}
                    </div>
                  </div>
                )
              )
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Clean Streaming Input Bar */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleSendChat(chatInput);
            }}
            className="p-3 border-t border-slate-100 bg-[#F8FAFC]/60 flex items-center gap-2"
          >
            <input
              type="text"
              data-testid="triage-chat-input"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Ask anything about this alert..."
              aria-label="Ask anything about this alert"
              disabled={isStreamingChat}
              className="flex-1 bg-white border border-[#E2E8F0] rounded-xl px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600 transition-colors disabled:opacity-60"
            />
            {isStreamingChat ? (
              <button
                type="button"
                onClick={handleStopStreaming}
                aria-label="Stop streaming"
                className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-slate-900 text-white hover:bg-slate-800 transition-colors shrink-0"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                data-testid="triage-chat-send"
                disabled={!chatInput.trim()}
                aria-label="Send message"
                className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-slate-900 text-white hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400 transition-colors shrink-0"
              >
                <ArrowUp className="w-4 h-4" />
              </button>
            )}
          </form>
        </div>

        {/* 5. Structured Tool Check Findings (Only shown when actively investigating or findings exist) */}
        {(isInvestigating || inv) && (
          <div className="rounded-2xl bg-white border border-[#E2E8F0] p-5 space-y-4">
            {isInvestigating ? (
              <div className="space-y-2.5 animate-pulse py-1" aria-busy="true">
                <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
                  <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                  <span>Checking your connected tools...</span>
                </div>
                <div className="h-3.5 w-full bg-slate-100 rounded" />
                <div className="h-3.5 w-4/5 bg-slate-100 rounded" />
              </div>
            ) : inv ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold text-slate-900">
                    Connected tool findings
                  </h2>
                  <span className="text-xs text-slate-500 tabular-nums">
                    {inv.toolsTotal > 0
                      ? `Checked ${inv.toolsUsed.length} of ${inv.toolsTotal} tools`
                      : 'Analyzed with Gemini'}
                  </span>
                </div>

                <div className="space-y-1.5">
                  <p className="text-sm text-slate-800 leading-relaxed">{inv.diagnosis}</p>
                  <p className="text-xs text-slate-500 leading-relaxed">{inv.customerImpact}</p>
                </div>

                <div className="space-y-2 pt-2.5 border-t border-slate-100">
                  <p className="text-xs font-medium text-slate-800">{inv.remediationPlan}</p>
                  <ol className="space-y-1">
                    {inv.remediationSteps.map((step, idx) => (
                      <li key={idx} className="flex items-start gap-2 text-xs text-slate-600">
                        <span className="font-medium text-slate-400 tabular-nums w-4 shrink-0">
                          {idx + 1}.
                        </span>
                        <span className="leading-relaxed">{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>

                <div className="flex flex-wrap items-center gap-2.5 pt-2 border-t border-slate-100">
                  {!isResolved && (
                    <button
                      type="button"
                      data-testid="approve-and-reply-btn"
                      onClick={() => onApproveAndFix(groupIds, incident)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Approve &amp; Reply</span>
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={isSendingSlack || isOfflineSimulated}
                    onClick={() => onSendToSlack(incident)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-[#E2E8F0] hover:bg-slate-50 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap"
                  >
                    <Send className="w-3.5 h-3.5 text-slate-500" />
                    <span>
                      {isSendingSlack
                        ? 'Sending...'
                        : incident.slackPosted
                          ? 'Sent to Slack'
                          : 'Send to Slack'}
                    </span>
                  </button>
                </div>
              </>
            ) : null}
          </div>
        )}

        {/* Quiet Slack Thread Confirmation */}
        {incident.slackPosted && (
          <div className="px-4 py-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-xs text-slate-600 space-y-1">
            <p className="font-medium text-slate-800">Posted update to {slackChannel}</p>
            <p className="whitespace-pre-line leading-relaxed">
              {incident.slackThreadNote || inv?.slackSummary}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
