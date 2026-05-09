import { SynthesisLive } from "@/components/synthesis/synthesis-live";
import { loadSpec } from "@/lib/load-spec";

export const dynamic = "force-static";

export default async function SynthesisPage() {
  const spec = await loadSpec();
  return <SynthesisLive spec={spec} />;
}
