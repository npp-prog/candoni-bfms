import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type Tone = 'success' | 'error' | 'info';
interface Toast { id: number; tone: Tone; message: string }
interface ToastApi { notify(message: string, tone?: Tone): void }

const Ctx = createContext<ToastApi | null>(null);
let seq = 0;

/** Toasts replace browser alert() for ordinary messages. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const notify = useCallback((message: string, tone: Tone = 'info') => {
    const id = ++seq;
    setToasts((t) => [...t, { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 8000 : 4000);
  }, []);
  const toneCls: Record<Tone, string> = {
    success: 'border-emerald-300 bg-emerald-50 text-emerald-900',
    error: 'border-red-300 bg-red-50 text-red-900',
    info: 'border-navy-200 bg-navy-50 text-navy-900',
  };
  return (
    <Ctx.Provider value={{ notify }}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className={`pointer-events-auto rounded-md border px-4 py-3 text-sm shadow ${toneCls[t.tone]}`}>
            {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast must be used inside ToastProvider');
  return v;
}
