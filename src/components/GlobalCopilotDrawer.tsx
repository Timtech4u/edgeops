import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  ArrowUp,
  BellRing,
  Check,
  Copy,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import {
  buildExecutiveBriefingFallback,
  buildOfflineWorkspaceReply,
  buildWorkspaceThreadSummaries,
  matchReferencedThreadsInText,
  type ProactiveThreadRef,
} from '../lib/copilotBriefing';
import { runLocalWorkspaceChat } from '../lib/hybridAi';
import type { IncidentGroup } from '../lib/incidentGroups';
import { scrubPiiLocally } from '../lib/privacyShield';

export interface CopilotMessage {
  id: string;
  role: 'user' | 'assistant' | 'proactive';
  text: string;
  engine?: 'on_device' | 'cloud' | 'proactive';
  engineLabel?: string;
  streaming?: boolean;
  error?: boolean;
  referencedThreads?: ProactiveThreadRef[];
  timestampLabel?: string;
}

interface GlobalCopilotDrawerProps {
  workspaceName: string;
  groups: IncidentGroup[];
  isOpen: boolean;
  unreadCount: number;
  messages: CopilotMessage[];
  isOfflineSimulated: boolean;
  onToggleOpen: () => void;
  onClose: () => void;
  onAppendMessage: (msg: CopilotMessage) => void;
  onUpdateMessage: (id: string, updater: (prev: CopilotMessage) => CopilotMessage) => void;
  onClearMessages: () => void;
  onJumpToGroup: (groupKey: string) => void;
  onSendTestNotification: () => void;
}

function renderInlineFormatted(text: string) {
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
          className="font-mono text-[11px] bg-slate-100 text-slate-800 px-1 py-0.5 rounded"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (/^\[Protected (?:Email|Phone|Account|Card)\]$/.test(part)) {
      return (
        <span
          key={idx}
          className="inline-block bg-emerald-50 text-emerald-800 border border-emerald-200 rounded px-1 py-0.5 font-mono text-[10px]"
        >
          {part}
        </span>
      );
    }
    return <span key={idx}>{part}</span>;
  });
}

function renderCopilotMarkdown(text: string) {
  const lines = text.split('\n');
  return (
    <div className="space-y-1.5">
      {lines.map((rawLine, idx) => {
        const line = rawLine.trim();
        if (!line) return <div key={idx} className="h-0.5" />;
        const headingMatch = line.match(/^#{1,4}\s+(.*)$/);
        if (headingMatch) {
          return (
            <p key={idx} className="font-semibold text-slate-900 pt-1 leading-snug">
              {renderInlineFormatted(headingMatch[1].replace(/^\*\*(.*)\*\*$/, '$1'))}
            </p>
          );
        }
        const bulletMatch = line.match(/^[-*•]\s+(.*)$/);
        if (bulletMatch) {
          return (
            <div key={idx} className="flex items-start gap-2 pl-0.5">
              <span className="mt-2 w-1 h-1 rounded-full bg-slate-400 shrink-0" aria-hidden="true" />
              <span className="leading-relaxed">{renderInlineFormatted(bulletMatch[1])}</span>
            </div>
          );
        }
        const numberedMatch = line.match(/^(\d+\.)\s+(.*)$/);
        if (numberedMatch) {
          return (
            <div key={idx} className="flex items-start gap-1.5 pl-0.5">
              <span className="text-[11px] font-medium text-slate-500 tabular-nums pt-0.5 shrink-0">
                {numberedMatch[1]}
              </span>
              <span className="leading-relaxed">{renderInlineFormatted(numberedMatch[2])}</span>
            </div>
          );
        }
        return (
          <p key={idx} className="leading-relaxed">
            {renderInlineFormatted(line)}
          </p>
        );
      })}
    </div>
  );
}

export function GlobalCopilotDrawer({
  workspaceName,
  groups,
  isOpen,
  unreadCount,
  messages,
  isOfflineSimulated,
  onToggleOpen,
  onClose,
  onAppendMessage,
  onUpdateMessage,
  onClearMessages,
  onJumpToGroup,
  onSendTestNotification,
}: GlobalCopilotDrawerProps) {
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const threadSummaries = useMemo(() => buildWorkspaceThreadSummaries(groups, 25), [groups]);
  const activeCount = useMemo(
    () => threadSummaries.filter((t) => !t.resolved && t.bucket === 'needs_action').length,
    [threadSummaries]
  );

  useEffect(() => {
    if (isOpen) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [isOpen, messages.length, isStreaming]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Visual confirmation fallback
    }
    setCopiedId(id);
    setTimeout(() => setCopiedId((curr) => (curr === id ? null : curr)), 2000);
  };

  const handleStop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  };

  const handleRunWindowBriefing = async () => {
    if (isStreaming) return;
    const clientTz = (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      } catch {
        return 'UTC';
      }
    })();

    const assistantMsgId = `brief_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
    const fallback = buildExecutiveBriefingFallback(threadSummaries, {
      workspaceName,
      timeZone: clientTz,
    });
    const topRefs: ProactiveThreadRef[] = threadSummaries
      .filter((t) => !t.resolved && (t.route === 'page_eng' || t.route === 'notify_ops' || t.bucket === 'needs_action'))
      .slice(0, 3)
      .map((t) => ({
        groupKey: t.groupKey,
        latestId: t.latestId,
        title: t.title,
        channel: t.channel,
        count: t.count,
        priorityScore: t.priorityScore,
        revenueRisk: t.revenueRisk,
        route: t.route,
        isUrgent: (t.priorityScore ?? 0) >= 90,
        isSpike: t.count >= 2,
      }));

    if (isOfflineSimulated || threadSummaries.length === 0) {
      onAppendMessage({
        id: assistantMsgId,
        role: 'proactive',
        text: fallback.body,
        engine: 'on_device',
        engineLabel: 'Window briefing · On-Device',
        referencedThreads: topRefs,
      });
      return;
    }

    onAppendMessage({
      id: assistantMsgId,
      role: 'proactive',
      text: '',
      engine: 'proactive',
      engineLabel: 'Window briefing · Decisions API',
      streaming: true,
    });
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/briefing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          workspaceName,
          timeZone: clientTz,
          threads: threadSummaries,
        }),
      });
      if (!res.ok) throw new Error(`Briefing failed (${res.status})`);
      const data = (await res.json()) as {
        ok?: boolean;
        briefing?: string;
        modelUsed?: string;
      };
      const finalBody =
        typeof data.briefing === 'string' && data.briefing.trim().length > 20
          ? data.briefing.trim()
          : fallback.body;
      const matched = matchReferencedThreadsInText(finalBody, threadSummaries, 3);
      onUpdateMessage(assistantMsgId, (prev) => ({
        ...prev,
        text: finalBody,
        engine: 'proactive',
        engineLabel:
          data.modelUsed && data.modelUsed !== 'deterministic-local'
            ? `Window briefing · Decisions API`
            : 'Window briefing · On-Device',
        streaming: false,
        referencedThreads: matched.length > 0 ? matched : topRefs,
      }));
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        onUpdateMessage(assistantMsgId, (prev) => ({
          ...prev,
          text: prev.text || fallback.body,
          streaming: false,
          referencedThreads: topRefs,
        }));
        return;
      }
      onUpdateMessage(assistantMsgId, (prev) => ({
        ...prev,
        text: fallback.body,
        engine: 'on_device',
        engineLabel: 'Window briefing · On-Device',
        streaming: false,
        referencedThreads: topRefs,
      }));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setIsStreaming(false);
    }
  };

  const handleSend = async (rawPrompt: string) => {
    const trimmed = rawPrompt.trim();
    if (!trimmed || isStreaming) return;

    const safePrompt = scrubPiiLocally(trimmed).scrubbedText;
    const userMsgId = `cu_${Date.now().toString(36)}`;
    const assistantMsgId = `ca_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;

    const priorHistory = messages
      .filter((m) => !m.error && m.text.trim().length > 0)
      .slice(-6)
      .map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        text: m.text,
      }));

    setInput('');
    onAppendMessage({
      id: userMsgId,
      role: 'user',
      text: trimmed,
    });
    onAppendMessage({
      id: assistantMsgId,
      role: 'assistant',
      text: '',
      engine: isOfflineSimulated ? 'on_device' : 'cloud',
      engineLabel: isOfflineSimulated ? 'On-Device' : 'Cloud · Streaming',
      streaming: true,
    });
    setIsStreaming(true);

    // 1. Offline / Chrome Gemini Nano local path
    const offlineFallback = buildOfflineWorkspaceReply(safePrompt, threadSummaries);
    const localResult = await runLocalWorkspaceChat({
      prompt: safePrompt,
      workspaceName,
      threads: threadSummaries,
      simulateOffline: isOfflineSimulated,
      offlineFallbackText: offlineFallback,
    });

    if (localResult?.handledLocally) {
      const refs = matchReferencedThreadsInText(localResult.text, threadSummaries, 3);
      onUpdateMessage(assistantMsgId, (prev) => ({
        ...prev,
        text: localResult.text,
        engine: localResult.engine,
        engineLabel: localResult.engineLabel,
        streaming: false,
        referencedThreads: refs,
      }));
      setIsStreaming(false);
      return;
    }

    // 2. Live Workspace-Wide SSE Streaming via POST /api/chat (scope: "workspace")
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          scope: 'workspace',
          workspaceName,
          message: safePrompt,
          history: priorHistory,
          threads: threadSummaries,
        }),
      });

      if (!response.ok || !response.body) {
        const errText = await response.text().catch(() => '');
        throw new Error(errText || `Copilot stream failed (${response.status})`);
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
              error?: string;
            };
            if (payload.type === 'delta' && typeof payload.text === 'string') {
              accumulated += payload.text;
              const nextText = accumulated;
              onUpdateMessage(assistantMsgId, (prev) => ({
                ...prev,
                text: nextText,
                engine: 'cloud',
                engineLabel: 'Cloud · Streaming',
                streaming: true,
              }));
            } else if (payload.type === 'error') {
              streamError = payload.error || 'Unable to reach Copilot right now.';
            }
          } catch {
            // ignore partial SSE JSON
          }
        }
      }

      const finalText = accumulated.trim();
      const refs = finalText ? matchReferencedThreadsInText(finalText, threadSummaries, 3) : [];

      onUpdateMessage(assistantMsgId, (prev) => ({
        ...prev,
        text: finalText || streamError || 'No response received. Please try again.',
        error: !finalText,
        streaming: false,
        referencedThreads: refs,
      }));
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        onUpdateMessage(assistantMsgId, (prev) => ({ ...prev, streaming: false }));
        return;
      }
      const msg = err instanceof Error ? err.message : 'Unable to reach Copilot right now.';
      onUpdateMessage(assistantMsgId, (prev) => ({
        ...prev,
        text: prev.text.trim().length > 0 ? prev.text : msg,
        error: prev.text.trim().length === 0,
        streaming: false,
      }));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setIsStreaming(false);
    }
  };

  return (
    <>
      {/* Floating Copilot Drawer (~400px sleek light card) */}
      {isOpen && (
        <section
          aria-label="CalmDuty Copilot"
          data-testid="copilot-drawer"
          className="fixed bottom-20 right-4 sm:right-6 z-40 w-[calc(100vw-2rem)] max-w-[400px] h-[min(560px,calc(100vh-7.5rem))] bg-white border border-[#E2E8F0] rounded-2xl shadow-2xl shadow-slate-900/12 flex flex-col overflow-hidden"
        >
          {/* Drawer Header */}
          <div className="px-4 py-3 border-b border-[#E2E8F0] flex items-center justify-between gap-2 shrink-0 bg-white">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="w-7 h-7 rounded-lg bg-slate-900 text-white flex items-center justify-center shrink-0">
                <Sparkles className="w-3.5 h-3.5" />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <h2 className="text-sm font-semibold text-slate-900 truncate">CalmDuty Copilot</h2>
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border whitespace-nowrap ${
                      isOfflineSimulated
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200/80'
                        : 'bg-[#F8FAFC] text-slate-500 border-[#E2E8F0]'
                    }`}
                  >
                    {isOfflineSimulated ? 'On-Device' : 'Streaming'}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 truncate tabular-nums">
                  {activeCount > 0
                    ? `Watching ${activeCount} actionable ${activeCount === 1 ? 'thread' : 'threads'} · Protected`
                    : 'Watching all synced Slack threads · Protected'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                data-testid="copilot-test-notif-btn"
                title="Send test alert notification"
                aria-label="Send test alert notification"
                onClick={onSendTestNotification}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
              >
                <BellRing className="w-3.5 h-3.5" />
              </button>
              {messages.length > 0 && !isStreaming && (
                <button
                  type="button"
                  onClick={onClearMessages}
                  className="px-2 py-1 text-[11px] font-medium text-slate-400 hover:text-slate-700 rounded-md transition-colors"
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                aria-label="Close Copilot"
                data-testid="copilot-close-btn"
                onClick={onClose}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* 1-Click Global Quick Chips */}
          <div className="px-3.5 pt-2.5 pb-2 border-b border-slate-100 bg-[#F8FAFC]/70 flex flex-wrap gap-1.5 shrink-0">
            <button
              type="button"
              data-testid="copilot-quick-briefing"
              disabled={isStreaming}
              onClick={() => void handleRunWindowBriefing()}
              className="px-2.5 py-1 rounded-lg text-[11px] font-semibold text-blue-700 bg-blue-50/80 border border-blue-200/90 hover:bg-blue-100/80 disabled:opacity-50 transition-colors"
            >
              Window briefing
            </button>
            <button
              type="button"
              data-testid="copilot-quick-urgent"
              disabled={isStreaming}
              onClick={() =>
                void handleSend(
                  'Summarize the top urgent fires across all synced alerts and tell me what needs attention first.'
                )
              }
              className="px-2.5 py-1 rounded-lg text-[11px] font-medium text-slate-700 bg-white border border-[#E2E8F0] hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50 transition-colors"
            >
              Summarize urgent fires
            </button>
            <button
              type="button"
              data-testid="copilot-quick-revenue"
              disabled={isStreaming}
              onClick={() =>
                void handleSend(
                  "What's currently blocking revenue or carrying the highest SLA/compliance risk across our alerts?"
                )
              }
              className="px-2.5 py-1 rounded-lg text-[11px] font-medium text-slate-700 bg-white border border-[#E2E8F0] hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50 transition-colors"
            >
              What&apos;s blocking revenue?
            </button>
            <button
              type="button"
              data-testid="copilot-quick-standup"
              disabled={isStreaming}
              onClick={() =>
                void handleSend(
                  'Draft a crisp 4-bullet team standup update covering active alerts, repeated spikes, and next priorities.'
                )
              }
              className="px-2.5 py-1 rounded-lg text-[11px] font-medium text-slate-700 bg-white border border-[#E2E8F0] hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50 transition-colors"
            >
              Draft team standup
            </button>
          </div>

          {/* Messages & Proactive Briefings */}
          <div className="flex-1 overflow-y-auto px-3.5 py-3 space-y-3">
            {messages.length === 0 ? (
              <div className="py-6 px-2 text-center space-y-2">
                <p className="text-xs font-medium text-slate-700">
                  Your workspace copilot is ready
                </p>
                <p className="text-xs text-slate-400 leading-relaxed">
                  I automatically watch all synced alerts (with personal details scrubbed on your device) and post proactive briefings when urgent fires or repeated spikes appear.
                </p>
              </div>
            ) : (
              messages.map((msg) =>
                msg.role === 'user' ? (
                  <div key={msg.id} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-slate-900 text-white px-3 py-2 text-xs leading-relaxed">
                      {msg.text}
                    </div>
                  </div>
                ) : (
                  <div
                    key={msg.id}
                    data-testid={
                      msg.role === 'proactive'
                        ? 'copilot-proactive-briefing'
                        : 'copilot-assistant-msg'
                    }
                    className={`rounded-xl border px-3.5 py-3 space-y-2.5 ${
                      msg.role === 'proactive'
                        ? 'bg-blue-50/45 border-blue-200/80'
                        : 'bg-[#F8FAFC] border-[#E2E8F0]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${
                          msg.role === 'proactive' ? 'text-blue-700' : 'text-slate-500'
                        }`}
                      >
                        {msg.role === 'proactive' && (
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-600" aria-hidden="true" />
                        )}
                        <span>
                          {msg.role === 'proactive'
                            ? msg.engineLabel || 'Proactive briefing'
                            : msg.engineLabel || 'Cloud · Streaming'}
                        </span>
                      </span>

                      {!msg.streaming && msg.text.trim().length > 0 && !msg.error && (
                        <button
                          type="button"
                          onClick={() => void handleCopy(msg.id, msg.text)}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-slate-500 hover:text-slate-900 hover:bg-white transition-colors"
                        >
                          {copiedId === msg.id ? (
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
                      className={`text-xs break-words ${
                        msg.error ? 'text-rose-700' : 'text-slate-800'
                      }`}
                    >
                      {msg.text ? (
                        <div>
                          {renderCopilotMarkdown(msg.text)}
                          {msg.streaming && (
                            <span
                              className="inline-block w-1.5 h-3 mt-1 align-middle bg-blue-600 animate-pulse rounded-xs"
                              aria-hidden="true"
                            />
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">Analyzing workspace alerts...</span>
                      )}
                    </div>

                    {/* Clickable Referenced Alert Shortcuts */}
                    {msg.referencedThreads && msg.referencedThreads.length > 0 && (
                      <div className="pt-1.5 border-t border-slate-200/70 space-y-1.5">
                        {msg.referencedThreads.map((ref) => (
                          <button
                            key={ref.groupKey}
                            type="button"
                            data-testid="copilot-alert-ref"
                            onClick={() => onJumpToGroup(ref.groupKey)}
                            className="w-full text-left px-2.5 py-2 rounded-lg bg-white border border-[#E2E8F0] hover:border-blue-300 hover:bg-blue-50/30 transition-colors flex items-center justify-between gap-2 group"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                                <span className="font-medium text-slate-600 truncate">
                                  {ref.channel}
                                </span>
                                {ref.count > 1 && (
                                  <span className="px-1 py-0.2 rounded bg-slate-100 text-slate-700 font-semibold tabular-nums">
                                    ×{ref.count}
                                  </span>
                                )}
                                {ref.route === 'page_eng' && (
                                  <span className="px-1 py-0.2 rounded bg-rose-50 text-rose-700 font-semibold">
                                    Page Eng
                                  </span>
                                )}
                                {ref.route === 'notify_ops' && (
                                  <span className="px-1 py-0.2 rounded bg-blue-50 text-blue-700 font-semibold">
                                    Notify Ops
                                  </span>
                                )}
                                {ref.priorityScore !== null && ref.priorityScore >= 85 && (
                                  <span className="px-1 py-0.2 rounded bg-rose-50 text-rose-700 font-medium tabular-nums">
                                    {ref.priorityScore}%
                                  </span>
                                )}
                              </div>
                              <p className="text-xs font-medium text-slate-800 truncate mt-0.5 group-hover:text-blue-700">
                                {ref.title}
                              </p>
                            </div>
                            <ArrowRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-blue-600 shrink-0 transition-colors" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              )
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input Bar */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleSend(input);
            }}
            className="p-3 border-t border-[#E2E8F0] bg-[#F8FAFC]/70 flex items-center gap-2 shrink-0"
          >
            <input
              type="text"
              data-testid="copilot-chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask across all alerts..."
              aria-label="Ask CalmDuty Copilot across all alerts"
              disabled={isStreaming}
              className="flex-1 bg-white border border-[#E2E8F0] rounded-xl px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600 transition-colors disabled:opacity-60"
            />
            {isStreaming ? (
              <button
                type="button"
                onClick={handleStop}
                aria-label="Stop streaming"
                className="inline-flex items-center justify-center w-8 h-8 rounded-xl bg-slate-900 text-white hover:bg-slate-800 transition-colors shrink-0"
              >
                <Square className="w-3 h-3 fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                data-testid="copilot-chat-send"
                disabled={!input.trim()}
                aria-label="Send message to Copilot"
                className="inline-flex items-center justify-center w-8 h-8 rounded-xl bg-slate-900 text-white hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400 transition-colors shrink-0"
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
            )}
          </form>
        </section>
      )}

      {/* Floating Bottom-Right Circular Copilot FAB */}
      <button
        type="button"
        data-testid="copilot-fab"
        aria-label={isOpen ? 'Close CalmDuty Copilot' : 'Open CalmDuty Copilot'}
        aria-expanded={isOpen}
        onClick={onToggleOpen}
        className={`fixed bottom-5 right-4 sm:right-6 z-40 w-12 h-12 rounded-full flex items-center justify-center shadow-lg shadow-slate-900/20 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${
          isOpen
            ? 'bg-slate-800 text-white hover:bg-slate-700'
            : 'bg-slate-900 text-white hover:bg-blue-700'
        }`}
      >
        {isOpen ? <X className="w-5 h-5" /> : <Sparkles className="w-5 h-5" />}

        {!isOpen && unreadCount > 0 && (
          <span
            data-testid="copilot-unread-badge"
            className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-blue-600 text-white text-[11px] font-semibold tabular-nums flex items-center justify-center ring-2 ring-white"
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>
    </>
  );
}
