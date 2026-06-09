import { redirect } from "next/navigation";

// Manage merged into Settings (all configuration in one place).
export default function Page() {
  redirect("/settings");
}
