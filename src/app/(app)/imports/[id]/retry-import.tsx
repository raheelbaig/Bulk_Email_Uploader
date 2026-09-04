'use client';

import { useState, useTransition } from 'react';
import { RotateCcw } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { retryImportAction } from '../actions';

/**
 * Resumes an import whose background pass did not finish.
 *
 * Safe to press at any time, including while the import is running: the queue
 * claim is a single conditional UPDATE, so a second runner finds the job taken
 * and does nothing at all. There is no path here that processes a file twice.
 */
export function RetryImport({ importId }: { importId: string }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [ok, setOk] = useState(true);

  return (
    <div className="flex flex-col gap-2">
      {message !== null && <Alert tone={ok ? 'default' : 'destructive'}>{message}</Alert>}
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => {
            startTransition(async () => {
              const state = await retryImportAction(importId);
              setOk(state.ok);
              setMessage(state.message ?? (state.ok ? 'Done.' : 'That did not work.'));
            });
          }}
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          {pending ? 'Working…' : 'Resume this import'}
        </Button>
      </div>
    </div>
  );
}
