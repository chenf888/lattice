import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/ipc";
import type { ConnectionInput, ConnectionSummary } from "@/lib/types";

const CONNECTIONS_KEY = ["connections"] as const;

export function useConnections() {
  return useQuery({ queryKey: CONNECTIONS_KEY, queryFn: api.listConnections });
}

function useInvalidateConnections(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY });
  };
}

export function useCreateConnection() {
  const invalidate = useInvalidateConnections();
  return useMutation({
    mutationFn: api.createConnection,
    onSuccess: () => invalidate(),
  });
}

export function useUpdateConnection() {
  const invalidate = useInvalidateConnections();
  return useMutation({
    mutationFn: (vars: { id: string; input: ConnectionInput }) =>
      api.updateConnection(vars.id, vars.input),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteConnection() {
  const invalidate = useInvalidateConnections();
  return useMutation({
    mutationFn: api.deleteConnection,
    onSuccess: () => invalidate(),
  });
}

export function useSetConnectionFavorite() {
  const invalidate = useInvalidateConnections();
  return useMutation({
    mutationFn: (vars: { id: string; favorite: boolean }) =>
      api.setConnectionFavorite(vars.id, vars.favorite),
    onSuccess: () => invalidate(),
  });
}

export function useConnectConnection() {
  const invalidate = useInvalidateConnections();
  return useMutation({
    mutationFn: api.connectDatabase,
    onSuccess: () => invalidate(),
  });
}

export function useDisconnectConnection() {
  const invalidate = useInvalidateConnections();
  return useMutation({
    mutationFn: api.disconnectDatabase,
    onSuccess: () => invalidate(),
  });
}

export type { ConnectionSummary };
