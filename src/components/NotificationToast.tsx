import { Sparkles, X } from 'lucide-react';

export interface AlertToastPayload {
  id: string;
  title: string;
  body: string;
  tone: 'urgent' | 'info';
  targetGroupKey?: string | null;
}

interface NotificationToastProps {
  toast: AlertToastPayload | null;
  onOpenCopilot: () => void;
  onJumpToThread?: (groupKey: string) => void;
  onDismiss: () => void;
}

export function NotificationToast({
  toast,
  onOpenCopilot,
  onJumpToThread,
  onDismiss,
}: NotificationToastProps) {
  if (!toast) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="alert-notification-toast"
      className="fixed top-16 right-4 sm:right-6 z-50 w-[calc(100vw-2rem)] max-w-[360px] bg-white border border-[#E2E8F0] rounded-xl shadow-lg shadow-slate-900/10 p-3.5 animate-in fade-in slide-in-from-top-2 duration-200"
    >
      <div className="flex items-start gap-2.5">
        <span
          className={`mt-0.5 w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
            toast.tone === 'urgent'
              ? 'bg-rose-50 text-rose-600 border border-rose-200/80'
              : 'bg-blue-50 text-blue-600 border border-blue-200/80'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
        </span>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs font-semibold text-slate-900 leading-snug">{toast.title}</p>
            <button
              type="button"
              aria-label="Dismiss notification"
              data-testid="toast-dismiss-btn"
              onClick={onDismiss}
              className="text-slate-400 hover:text-slate-700 p-0.5 rounded transition-colors shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed line-clamp-2">{toast.body}</p>

          <div className="pt-1.5 flex items-center gap-2">
            <button
              type="button"
              data-testid="toast-open-copilot-btn"
              onClick={() => {
                onOpenCopilot();
                onDismiss();
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-slate-900 text-white hover:bg-slate-800 transition-colors"
            >
              <Sparkles className="w-3 h-3" />
              <span>Open Copilot</span>
            </button>

            {toast.targetGroupKey && onJumpToThread && (
              <button
                type="button"
                data-testid="toast-view-thread-btn"
                onClick={() => {
                  onJumpToThread(toast.targetGroupKey!);
                  onDismiss();
                }}
                className="px-2 py-1 rounded-md text-[11px] font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors"
              >
                View alert
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
