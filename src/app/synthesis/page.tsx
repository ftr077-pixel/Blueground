import { SynthesisLive } from "@/components/synthesis/synthesis-live";
import { loadSpec } from "@/lib/load-spec";
import { llmConfigured } from "@/lib/orchestrator/llm";
import { startScriptedRun } from "@/lib/orchestrator/scripted-driver";
import { latestRun } from "@/lib/repos/orchestrator";

export const dynamic = "force-dynamic";

export default async function SynthesisPage() {
  const spec = await loadSpec();
  // First-load UX: if there are no runs yet, seed one scripted run so the
  // page lights up instead of showing an empty state.
  let run = latestRun();
  if (!run) run = startScriptedRun();
  return (
    <SynthesisLive spec={spec} initialRunId={run.id} liveAvailable={llmConfigured()} />
  );
}
