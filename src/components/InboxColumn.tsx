import { useMemo, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { getPriorityBadge, getRouteBadge } from '../lib/decisions';
import { formatSlackText } from '../lib/slackSync';
import type { IncidentGroup } from '../lib/incidentGroups';
import type { IncidentBucket } from '../types/edgeops';

interface InboxColumnProps {
  groups: IncidentGroup[];
  selectedGroupKey: string | null;
  hiddenOnMobile?: boolean;
  botName: string;
  slackConnected?: boolean;
  isSyncingSlack?: boolean;
  autoSyncEnabled?: boolean;
  syncedChannelCount?: number;
  syncError?: string | null;
  onSyncSlack?: () => void;
  onToggleAutoSync?: () => void;
  onSelectGroup: (groupKey: string) => void;
}

export function InboxColumn({
  groups,
  selectedGroupKey,
  hiddenOnMobile = false,
  botName,
  slackConnected = false,
  isSyncingSlack = false,
  autoSyncEnabled = true,
  syncedChannelCount = 0,
  syncError = null,
  onSyncSlack,
  onToggleAutoSync,
  onSelectGroup,
}: InboxColumnProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeBucket, setActiveBucket] = useState<IncidentBucket>('needs_action');

  const { needsActionAll, hiddenNoiseAll } = useMemo(() => {
    const needsAction: IncidentGroup[] = [];
    const hiddenNoise: IncidentGroup[] = [];
    for (const group of groups) {
      if (group.bucket === 'hidden_noise') {
        hiddenNoise.push(group);
      } else {
        needsAction.push(group);
      }
    }
    return { needsActionAll: needsAction, hiddenNoiseAll: hiddenNoise };
  }, [groups]);

  const visibleList = useMemo(() => {
    const base = activeBucket === 'needs_action' ? needsActionAll : hiddenNoiseAll;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (group) =>
        group.latest.title.toLowerCase().includes(q) ||
        group.latest.channel.toLowerCase().includes(q) ||
        group.latest.scrubbedSummary.toLowerCase().includes(q) ||
        (group.entityName ? group.entityName.toLowerCase().includes(q) : false)
    );
  }, [activeBucket, needsActionAll, hiddenNoiseAll, searchQuery]);

  return (
    <aside
      aria-label="Inbox"
      className={`${
        hiddenOnMobile ? 'hidden min-[900px]:flex' : 'flex'
      } w-full min-[900px]:w-[340px] shrink-0 bg-white min-[900px]:border-r border-[#E2E8F0] flex-col min-[900px]:h-full min-[900px]:min-h-0`}
    >
      {/* Calm Inbox Header */}
      <div className="px-4 pt-4 pb-3 border-b border-[#E2E8F0] space-y-2.5 shrink-0">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Inbox</h2>
          <span className="text-xs text-slate-400 tabular-nums">
            {needsActionAll.length} actionable
          </span>
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search messages or channels..."
            aria-label="Search messages or channels"
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-blue-600 transition-colors"
          />
        </div>

        {/* Clean Bucket Filter Pills: Needs Action (default) & Hidden Noise */}
        <div
          role="tablist"
          aria-label="Filter inbox messages"
          className="grid grid-cols-2 gap-1.5 p-1 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeBucket === 'needs_action'}
            data-testid="inbox-tab-needs-action"
            onClick={() => setActiveBucket('needs_action')}
            className={`flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
              activeBucket === 'needs_action'
                ? 'bg-white text-slate-900 shadow-xs border border-slate-200/80'
                : 'text-slate-500 hover:text-slate-800 border border-transparent'
            }`}
          >
            <span>Needs Action</span>
            <span
              className={`text-[11px] tabular-nums px-1.5 py-0.2 rounded-full ${
                activeBucket === 'needs_action'
                  ? 'bg-slate-100 text-slate-700'
                  : 'text-slate-400'
              }`}
            >
              {needsActionAll.length}
            </span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeBucket === 'hidden_noise'}
            data-testid="inbox-tab-hidden-noise"
            onClick={() => setActiveBucket('hidden_noise')}
            className={`flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
              activeBucket === 'hidden_noise'
                ? 'bg-white text-slate-900 shadow-xs border border-slate-200/80'
                : 'text-slate-500 hover:text-slate-800 border border-transparent'
            }`}
          >
            <span>Hidden Noise</span>
            <span
              className={`text-[11px] tabular-nums px-1.5 py-0.2 rounded-full ${
                activeBucket === 'hidden_noise'
                  ? 'bg-slate-100 text-slate-700'
                  : 'text-slate-400'
              }`}
            >
              {hiddenNoiseAll.length}
            </span>
          </button>
        </div>

        {slackConnected && onSyncSlack && (
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <button
              type="button"
              data-testid="sync-slack-btn"
              disabled={isSyncingSlack}
              onClick={onSyncSlack}
              title="Read-only sync of recent messages from your connected Slack channels"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-[#E2E8F0] hover:bg-slate-50 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap"
            >
              <RefreshCw className={`w-3 h-3 text-slate-500 ${isSyncingSlack ? 'animate-spin' : ''}`} />
              <span>
                {isSyncingSlack
                  ? 'Syncing...'
                  : syncedChannelCount > 0
                    ? `Sync Slack (${syncedChannelCount})`
                    : 'Sync Slack'}
              </span>
            </button>

            {onToggleAutoSync && (
              <button
                type="button"
                data-testid="auto-sync-toggle"
                aria-pressed={autoSyncEnabled}
                onClick={onToggleAutoSync}
                title="Automatically check connected Slack channels every 30 seconds (read-only)"
                className={`inline-flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium rounded-lg border transition-colors whitespace-nowrap ${
                  autoSyncEnabled
                    ? 'bg-emerald-50/70 text-emerald-700 border-emerald-200'
                    : 'bg-white text-slate-500 border-[#E2E8F0] hover:text-slate-800'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    autoSyncEnabled ? 'bg-emerald-500' : 'bg-slate-300'
                  }`}
                  aria-hidden="true"
                />
                <span>Auto 30s</span>
              </button>
            )}
          </div>
        )}

        {syncError && (
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5 leading-snug">
            {syncError}
          </p>
        )}
      </div>

      {/* Grouped Thread List: Channel · ×N · Priority Pill · Time · Clean Title · 1-line preview */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
        {groups.length === 0 ? (
          <div className="px-6 py-12 text-center space-y-2">
            <p className="text-sm font-medium text-slate-900">Your inbox is clear</p>
            <p className="text-xs text-slate-500 leading-relaxed">
              Listening for new messages from{' '}
              <span className="font-medium text-slate-700">
                @{(botName || 'EdgeOps').replace(/^@/, '')}
              </span>
              .
            </p>
          </div>
        ) : visibleList.length === 0 ? (
          <div className="px-6 py-10 text-center space-y-2">
            {searchQuery.trim() ? (
              <>
                <p className="text-xs font-medium text-slate-700">No messages match your search</p>
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="text-xs text-blue-600 hover:text-blue-700"
                >
                  Clear filter
                </button>
              </>
            ) : activeBucket === 'needs_action' ? (
              <>
                <p className="text-sm font-medium text-slate-900">Nothing needs action right now</p>
                {hiddenNoiseAll.length > 0 && (
                  <p className="text-xs text-slate-500 leading-relaxed">
                    {hiddenNoiseAll.length} routine{' '}
                    {hiddenNoiseAll.length === 1 ? 'thread was' : 'threads were'} auto-filtered.{' '}
                    <button
                      type="button"
                      onClick={() => setActiveBucket('hidden_noise')}
                      className="font-medium text-blue-600 hover:text-blue-700"
                    >
                      View Hidden Noise
                    </button>
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-slate-500">No routine noise has been filtered yet.</p>
            )}
          </div>
        ) : (
          visibleList.map((group) => {
            const item = group.latest;
            const selected = group.groupKey === selectedGroupKey;
            const isResolved = group.occurrences.every((occ) => occ.status === 'resolved');
            const priorityBadge = getPriorityBadge({
              bucket: group.bucket,
              isNoise: group.bucket === 'hidden_noise',
              priorityScore: group.priorityScore,
              decisionScores: group.decisionScores,
            });
            const routeBadge = getRouteBadge(group.decisionScores ?? item.decisionScores);
            const cleanTitle = (formatSlackText(item.title) || item.title).replace(/\n+/g, ' ').trim();
            const cleanPreview = (formatSlackText(item.scrubbedSummary) || item.scrubbedSummary)
              .replace(/\n+/g, ' ')
              .trim();

            return (
              <button
                key={group.groupKey}
                type="button"
                data-testid={`inbox-item-${item.id}`}
                data-group-count={group.count}
                onClick={() => onSelectGroup(group.groupKey)}
                aria-current={selected ? 'true' : undefined}
                className={`w-full text-left px-4 py-3.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${
                  selected ? 'bg-[#F1F5F9]/80' : 'bg-white hover:bg-[#F8FAFC]'
                }`}
              >
                <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                  <span className="truncate font-medium text-slate-600">
                    {item.channel}
                    {isResolved && (
                      <span className="text-emerald-700 font-normal"> · Resolved</span>
                    )}
                  </span>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {group.count > 1 && (
                      <span
                        data-testid="group-count-badge"
                        title={`${group.count} repeated occurrences grouped`}
                        className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold tabular-nums leading-none bg-slate-100 text-slate-700 border border-slate-200/90 whitespace-nowrap"
                      >
                        ×{group.count}
                      </span>
                    )}
                    {routeBadge &&
                      (routeBadge.route === 'page_eng' || routeBadge.route === 'notify_ops') &&
                      !isResolved && (
                        <span
                          data-testid="inbox-route-pill"
                          className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold leading-none whitespace-nowrap border ${
                            routeBadge.route === 'page_eng'
                              ? 'bg-rose-50 text-rose-700 border-rose-200/90'
                              : 'bg-blue-50 text-blue-700 border-blue-200/90'
                          }`}
                        >
                          {routeBadge.shortLabel}
                        </span>
                      )}
                    {priorityBadge && !isResolved && (
                      <span
                        data-testid="inbox-priority-pill"
                        className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium tabular-nums leading-none whitespace-nowrap ${
                          priorityBadge.tone === 'urgent'
                            ? 'bg-rose-50 text-rose-700 border border-rose-200/90'
                            : 'bg-amber-50 text-amber-800 border border-amber-200/90'
                        }`}
                      >
                        {priorityBadge.label}
                      </span>
                    )}
                    <span className="tabular-nums text-[11px] text-slate-400">
                      {item.timestampLabel}
                    </span>
                  </div>
                </div>

                <p className="text-sm font-medium text-slate-900 mt-1 line-clamp-1">
                  {cleanTitle}
                </p>

                <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">
                  {cleanPreview}
                </p>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
