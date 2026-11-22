import { useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { Bell, BellOff, BellRing, Check, ChevronDown, Download, LogIn, LogOut, Plus, ShieldCheck, WifiOff } from 'lucide-react';
import type { OrgProfile } from '../types/edgeops';

export type BrowserNotificationPermission = 'default' | 'granted' | 'denied' | 'unsupported';

interface TopBarProps {
  orgName: string | null;
  activeOrgId: string | null;
  workspaces: OrgProfile[];
  onSelectWorkspace: (org: OrgProfile) => void;
  onCreateNewWorkspace: () => void;
  activeView: 'triage' | 'connectors';
  onChangeView: (view: 'triage' | 'connectors') => void;
  isOfflineSimulated: boolean;
  onToggleOffline: () => void;
  notificationsEnabled: boolean;
  notificationPermission: BrowserNotificationPermission;
  onToggleNotifications: () => void;
  onSendTestNotification: () => void;
  user: User | null;
  authLoading: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
}

export function TopBar({
  orgName,
  activeOrgId,
  workspaces,
  onSelectWorkspace,
  onCreateNewWorkspace,
  activeView,
  onChangeView,
  isOfflineSimulated,
  onToggleOffline,
  notificationsEnabled,
  notificationPermission,
  onToggleNotifications,
  onSendTestNotification,
  user,
  authLoading,
  onSignIn,
  onSignOut,
}: TopBarProps) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement | null>(null);
  const bellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!switcherOpen && !bellOpen) return;
    const handleOutside = (event: MouseEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(event.target as Node)) {
        setSwitcherOpen(false);
      }
      if (bellRef.current && !bellRef.current.contains(event.target as Node)) {
        setBellOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSwitcherOpen(false);
        setBellOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [switcherOpen, bellOpen]);

  const isNotificationsActive = notificationsEnabled && notificationPermission === 'granted';

  return (
    <header className="sticky top-0 z-30 bg-white border-b border-[#E2E8F0]">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
        {/* Left: Brand Wordmark + Org Switcher + Calm Text Navigation */}
        <div className="flex items-center gap-3 sm:gap-5 min-w-0 flex-1">
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onChangeView('triage')}
              className="flex items-center gap-2 text-left whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2B3BFF] rounded-md"
            >
              <span
                aria-hidden="true"
                className="w-3 h-3 rounded-full bg-[#2B3BFF] shrink-0"
              />
              <span className="font-editorial text-[18px] font-extrabold tracking-[-0.025em] text-[#0B0B0C]">
                CalmDuty
              </span>
            </button>

            <span className="text-slate-300 font-light shrink-0" aria-hidden="true">
              /
            </span>

            <div className="relative shrink-0" ref={switcherRef}>
              <button
                type="button"
                data-testid="workspace-switcher-trigger"
                aria-haspopup="menu"
                aria-expanded={switcherOpen}
                onClick={() => setSwitcherOpen((prev) => !prev)}
                className="inline-flex items-center flex-nowrap gap-1.5 px-2 py-1 text-sm font-medium text-slate-700 hover:text-slate-900 hover:bg-slate-100/80 rounded-md transition-colors max-w-[160px] shrink-0 overflow-hidden"
              >
                <span className="truncate">{orgName || 'Workspace'}</span>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
              </button>

              {switcherOpen && (
                <div
                  role="menu"
                  aria-label="Switch or create workspace"
                  className="absolute left-0 mt-1.5 w-64 bg-white border border-[#E2E8F0] rounded-xl shadow-lg shadow-slate-900/5 py-1.5 z-40"
                >
                  <div className="px-3 py-1.5 text-[11px] font-medium text-slate-400">
                    Switch workspace
                  </div>

                  <div className="max-h-56 overflow-y-auto">
                    {workspaces.length > 0 ? (
                      workspaces.map((org) => {
                        const isActive = org.orgId === activeOrgId;
                        return (
                          <button
                            key={org.orgId}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setSwitcherOpen(false);
                              onSelectWorkspace(org);
                            }}
                            className={`w-full px-3 py-2 text-left flex items-center justify-between gap-2 text-xs transition-colors ${
                              isActive
                                ? 'bg-slate-50 text-slate-900 font-medium'
                                : 'text-slate-700 hover:bg-slate-50'
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="truncate">{org.name}</div>
                              <div className="text-[11px] text-slate-400 truncate">
                                {org.slackTeam ? `Slack · ${org.slackTeam}` : 'Workspace'}
                              </div>
                            </div>
                            {isActive && <Check className="w-3.5 h-3.5 text-slate-900 shrink-0" />}
                          </button>
                        );
                      })
                    ) : (
                      <div className="px-3 py-2 text-xs text-slate-500">
                        {orgName || 'Current workspace'}
                      </div>
                    )}
                  </div>

                  <div className="mt-1 pt-1 border-t border-slate-100">
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="create-new-workspace-btn"
                      onClick={() => {
                        setSwitcherOpen(false);
                        onCreateNewWorkspace();
                      }}
                      className="w-full px-3 py-2 text-left flex items-center gap-2 text-xs font-medium text-blue-600 hover:bg-blue-50/60 transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5 shrink-0" />
                      <span>Create new workspace</span>
                    </button>
                    <a
                      href="/downloads/calmduty-v0.1.0-android.apk"
                      download="calmduty-v0.1.0-android.apk"
                      role="menuitem"
                      onClick={() => setSwitcherOpen(false)}
                      className="w-full px-3 py-2 text-left flex items-center gap-2 text-xs font-medium text-emerald-700 hover:bg-emerald-50/60 transition-colors"
                    >
                      <Download className="w-3.5 h-3.5 shrink-0" />
                      <span>Download Android APK</span>
                    </a>
                  </div>
                </div>
              )}
            </div>
          </div>

          <nav aria-label="Primary" className="flex items-center gap-4 sm:gap-5 shrink-0">
            <button
              type="button"
              data-testid="nav-inbox"
              onClick={() => onChangeView('triage')}
              className={`text-sm transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
                activeView === 'triage'
                  ? 'border-slate-900 text-slate-900 font-medium'
                  : 'border-transparent text-slate-500 hover:text-slate-900'
              }`}
            >
              Inbox
            </button>
            <button
              type="button"
              data-testid="nav-connections"
              onClick={() => onChangeView('connectors')}
              className={`text-sm transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
                activeView === 'connectors'
                  ? 'border-slate-900 text-slate-900 font-medium'
                  : 'border-transparent text-slate-500 hover:text-slate-900'
              }`}
            >
              Connections
            </button>
          </nav>
        </div>

        {/* Right: Quiet Notification Bell + Status Pill + Auth */}
        <div className="flex items-center flex-nowrap gap-2.5 shrink-0">
          {/* Quiet Notification Bell Popover */}
          <div className="relative shrink-0" ref={bellRef}>
            <button
              type="button"
              data-testid="notification-bell-btn"
              aria-label="Alert notifications"
              aria-haspopup="dialog"
              aria-expanded={bellOpen}
              onClick={() => setBellOpen((prev) => !prev)}
              title={
                isNotificationsActive
                  ? 'Browser notifications enabled'
                  : 'Configure browser alert notifications'
              }
              className={`relative inline-flex items-center justify-center w-8 h-8 rounded-lg border transition-colors shrink-0 ${
                bellOpen || isNotificationsActive
                  ? 'bg-slate-50 text-slate-900 border-[#E2E8F0]'
                  : 'bg-white text-slate-500 border-transparent hover:text-slate-900 hover:bg-slate-50'
              }`}
            >
              {notificationPermission === 'denied' ? (
                <BellOff className="w-4 h-4 text-slate-400" />
              ) : isNotificationsActive ? (
                <BellRing className="w-4 h-4 text-slate-800" />
              ) : (
                <Bell className="w-4 h-4" />
              )}
              {isNotificationsActive && (
                <span
                  data-testid="notification-bell-active-dot"
                  className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-emerald-500 ring-2 ring-white"
                  aria-hidden="true"
                />
              )}
            </button>

            {bellOpen && (
              <div
                role="dialog"
                aria-label="Notification preferences"
                data-testid="notification-popover"
                className="absolute right-0 mt-1.5 w-72 bg-white border border-[#E2E8F0] rounded-xl shadow-lg shadow-slate-900/10 p-3.5 z-50 space-y-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-slate-900">Alert notifications</p>
                    <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">
                      Notify on Urgent (90%+) alerts and proactive Copilot briefings.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isNotificationsActive}
                    data-testid="notification-toggle-switch"
                    disabled={notificationPermission === 'unsupported'}
                    onClick={onToggleNotifications}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 ${
                      isNotificationsActive ? 'bg-slate-900' : 'bg-slate-200'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-xs transform transition-transform ${
                        isNotificationsActive ? 'translate-x-4' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {notificationPermission === 'denied' && (
                  <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200/80 rounded-lg px-2.5 py-1.5 leading-snug">
                    Browser notifications are blocked for this site. Re-enable them in your browser address bar settings; in-app toasts remain active.
                  </p>
                )}

                {notificationPermission === 'unsupported' && (
                  <p className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200/80 rounded-lg px-2.5 py-1.5 leading-snug">
                    This browser doesn&apos;t support desktop notifications. In-app alert toasts stay active.
                  </p>
                )}

                <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-slate-400">
                    {isNotificationsActive ? 'Desktop + in-app' : 'In-app toast only'}
                  </span>
                  <button
                    type="button"
                    data-testid="send-test-notification-btn"
                    onClick={() => {
                      onSendTestNotification();
                      setBellOpen(false);
                    }}
                    className="text-[11px] font-medium text-blue-600 hover:text-blue-700 whitespace-nowrap"
                  >
                    Send test alert notification
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="relative group shrink-0">
            <button
              type="button"
              data-testid="header-status-pill"
              onClick={onToggleOffline}
              aria-pressed={isOfflineSimulated}
              title={
                isOfflineSimulated
                  ? 'Working offline — privacy protection and reply drafts still run on your device'
                  : 'Runs privately on your device with Gemini Nano'
              }
              className={`inline-flex items-center flex-nowrap gap-1.5 h-7 px-2.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                isOfflineSimulated
                  ? 'bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100/70'
                  : 'bg-emerald-50/80 text-emerald-800 border border-emerald-200/80 hover:bg-emerald-100/60'
              }`}
            >
              {isOfflineSimulated ? (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
                  <WifiOff className="w-3.5 h-3.5 text-amber-700 shrink-0" aria-hidden="true" />
                  <span>Offline</span>
                </>
              ) : (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" aria-hidden="true" />
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" aria-hidden="true" />
                  <span>Private</span>
                </>
              )}
            </button>
            <div
              role="tooltip"
              className="pointer-events-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity absolute right-0 top-full mt-2 w-60 px-3 py-2 rounded-lg bg-slate-900 text-white text-[11px] leading-snug shadow-md z-50"
            >
              {isOfflineSimulated
                ? 'Working offline — privacy protection and reply drafts still run on your device. Click to reconnect.'
                : 'Runs privately on your device with Gemini Nano'}
            </div>
          </div>

          {user ? (
            <button
              type="button"
              onClick={onSignOut}
              aria-label="Sign out"
              title={user.email || 'Sign out'}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden md:inline">Sign out</span>
            </button>
          ) : (
            <button
              type="button"
              disabled={authLoading}
              onClick={onSignIn}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-[#E2E8F0] hover:bg-slate-50 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>{authLoading ? 'Connecting...' : 'Sign in'}</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
