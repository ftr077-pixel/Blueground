import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ListingHistory } from "@/components/visibility/listing-history";

export const dynamic = "force-dynamic";

export default function ListingDetailPage({ params }: { params: { id: string } }) {
  return (
    <div className="space-y-6">
      <Link
        href="/visibility"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Search Visibility
      </Link>
      <ListingHistory id={params.id} />
    </div>
  );
}
