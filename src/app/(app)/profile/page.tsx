import { redirect } from "next/navigation";

// /profile is the legacy URL. Account info moved to /account and theme moved
// to /settings — both reachable from the user menu in the top bar.
export default function ProfileRedirect() {
  redirect("/account");
}
