"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { api } from "@/lib/trpc-client";

type Region = "US" | "EU" | "KR" | "TW";

export default function AdminUsersPage() {
  const [search, setSearch] = useState("");
  const [region, setRegion] = useState<Region | "">("");
  const [realmSlug, setRealmSlug] = useState<string>("");
  const [guildId, setGuildId] = useState<string>("");
  const [adminOnly, setAdminOnly] = useState(false);
  const [page, setPage] = useState(1);
  // Delete-confirm lightbox target (replaces window.confirm). Purely client-side
  // UX — the real gate is the server admin check in admin.deleteUser.
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    label: string;
  } | null>(null);

  const filters = api.admin.filterOptions.useQuery();
  const utils = api.useUtils();

  const realms = useMemo(() => {
    const all = filters.data?.realms ?? [];
    return region ? all.filter((r) => r.region === region) : all;
  }, [filters.data, region]);

  const users = api.admin.listUsers.useQuery({
    search: search.trim() || undefined,
    region: region || undefined,
    realmSlug: realmSlug || undefined,
    guildId: guildId || undefined,
    adminOnly,
    page,
    pageSize: 25,
  });

  const setAdmin = api.admin.setUserAdmin.useMutation({
    onSuccess: () => {
      utils.admin.listUsers.invalidate();
      utils.admin.overview.invalidate();
    },
  });
  const deleteUser = api.admin.deleteUser.useMutation({
    onSuccess: () => {
      setDeleteTarget(null);
      utils.admin.listUsers.invalidate();
      utils.admin.overview.invalidate();
    },
  });

  const total = users.data?.total ?? 0;
  const pageSize = users.data?.pageSize ?? 25;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <section className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Filter</CardTitle>
          <CardDescription>
            Filters AND together; an empty value means &ldquo;any&rdquo;.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="space-y-1">
            <Label htmlFor="admin-search">Search</Label>
            <Input
              id="admin-search"
              placeholder="email or display name"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="admin-region">Region</Label>
            <select
              id="admin-region"
              value={region}
              onChange={(e) => {
                const v = e.target.value as Region | "";
                setRegion(v);
                setRealmSlug("");
                setPage(1);
              }}
              className="border-border bg-background h-9 w-full rounded-md border px-2 text-sm"
            >
              <option value="">Any</option>
              {filters.data?.regions.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.value} ({r.count})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="admin-realm">Server (realm)</Label>
            <select
              id="admin-realm"
              value={realmSlug}
              onChange={(e) => {
                setRealmSlug(e.target.value);
                setPage(1);
              }}
              className="border-border bg-background h-9 w-full rounded-md border px-2 text-sm"
            >
              <option value="">Any</option>
              {realms.map((r) => (
                <option key={`${r.region}-${r.realmSlug}`} value={r.realmSlug}>
                  {r.realmSlug} ({r.region}) · {r.count}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="admin-guild">Guild</Label>
            <select
              id="admin-guild"
              value={guildId}
              onChange={(e) => {
                setGuildId(e.target.value);
                setPage(1);
              }}
              className="border-border bg-background h-9 w-full rounded-md border px-2 text-sm"
            >
              <option value="">Any</option>
              {filters.data?.guilds.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.region}/{g.realmSlug})
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <label className="text-foreground inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={adminOnly}
                onChange={(e) => {
                  setAdminOnly(e.target.checked);
                  setPage(1);
                }}
              />
              Admins only
            </label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-baseline justify-between">
          <div>
            <CardTitle className="text-lg">
              Users <span className="text-muted-foreground text-sm">({total})</span>
            </CardTitle>
            <CardDescription>
              Page {page} of {totalPages}.
            </CardDescription>
          </div>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1 || users.isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= totalPages || users.isFetching}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {users.isPending ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : users.error ? (
            <p className="text-destructive text-sm" role="alert">
              {users.error.message}
            </p>
          ) : users.data && users.data.rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">No users match.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">User list</caption>
                <thead>
                  <tr className="text-muted-foreground text-left text-xs uppercase">
                    <th scope="col" className="py-1 pr-3 font-medium">User</th>
                    <th scope="col" className="py-1 pr-3 font-medium">Email verified</th>
                    <th scope="col" className="py-1 pr-3 font-medium">2FA</th>
                    <th scope="col" className="py-1 pr-3 font-medium">Chars</th>
                    <th scope="col" className="py-1 pr-3 font-medium">Guilds</th>
                    <th scope="col" className="py-1 pr-3 font-medium">Created</th>
                    <th scope="col" className="py-1 pr-3 font-medium">Admin</th>
                    <th scope="col" className="py-1 pr-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {users.data?.rows.map((u) => (
                    <tr key={u.id}>
                      <td className="py-2 pr-3">
                        <p className="font-medium">{u.displayName ?? u.email}</p>
                        {u.displayName && (
                          <p className="text-muted-foreground text-xs">{u.email}</p>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        {u.emailVerified ? "Yes" : "—"}
                      </td>
                      <td className="py-2 pr-3">{u.mfaEnabled ? "On" : "Off"}</td>
                      <td className="py-2 pr-3 tabular-nums">
                        {u._count.characters}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {u._count.guildMemberships}
                      </td>
                      <td className="text-muted-foreground py-2 pr-3 text-xs">
                        {new Date(u.createdAt).toLocaleDateString()}
                      </td>
                      <td className="py-2 pr-3">
                        <Button
                          size="sm"
                          variant={u.isAdmin ? "destructive" : "outline"}
                          disabled={setAdmin.isPending}
                          onClick={() =>
                            setAdmin.mutate({
                              userId: u.id,
                              isAdmin: !u.isAdmin,
                            })
                          }
                        >
                          {u.isAdmin ? "Revoke admin" : "Make admin"}
                        </Button>
                      </td>
                      <td className="py-2 pr-3">
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() =>
                            setDeleteTarget({
                              id: u.id,
                              label: u.displayName ?? u.email ?? "this user",
                            })
                          }
                        >
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {setAdmin.error && (
            <p className="text-destructive mt-3 text-sm" role="alert">
              {setAdmin.error.message}
            </p>
          )}
        </CardContent>
      </Card>

      <Modal
        open={deleteTarget != null}
        onClose={() => {
          if (!deleteUser.isPending) setDeleteTarget(null);
        }}
        title="Delete user?"
        description="This permanently removes the account and cannot be undone."
        hideDefaultFooter
      >
        <div className="space-y-3 text-sm">
          <p className="text-foreground">
            Permanently delete <strong>{deleteTarget?.label}</strong>? This
            removes their account, characters, snapshots, memberships and
            signups. Any raid teams they lead or guilds they claimed become
            leaderless / unclaimed.
          </p>
          {deleteUser.error && (
            <p className="text-destructive" role="alert">
              {deleteUser.error.message}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteUser.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                deleteTarget && deleteUser.mutate({ userId: deleteTarget.id })
              }
              disabled={deleteUser.isPending}
            >
              {deleteUser.isPending ? "Deleting…" : "Delete permanently"}
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
