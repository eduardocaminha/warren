import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { conversationsApi } from "@/api/client.ts";
import type { ConversationRow } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { formatError } from "@/lib/format-error.ts";

export interface RewakeButtonProps {
	readonly conversation: ConversationRow;
	readonly isAnchoringRunTerminal: boolean;
}

export function RewakeButton({ conversation, isAnchoringRunTerminal }: RewakeButtonProps): JSX.Element | null {
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const [runtimeOverride, setRuntimeOverride] = useState("pi-chat");

	const rewakeMutation = useMutation({
		mutationFn: () => conversationsApi.rewake(conversation.id, { runtimeOverride }),
		onSuccess: () => {
			toast({
				title: "Conversation re-woken",
				description: "A new anchoring run has been started.",
				variant: "success",
			});
			queryClient.invalidateQueries({ queryKey: ["conversation", conversation.id] });
			queryClient.invalidateQueries({ queryKey: ["conversations"] });
		},
		onError: (err) => {
			toast({
				title: "Failed to re-wake conversation",
				description: formatError(err),
				variant: "danger",
			});
		},
	});

	const isActive = conversation.status === "active";

	if (!isActive || !isAnchoringRunTerminal) {
		return null;
	}

	return (
		<>
			<select
				value={runtimeOverride}
				onChange={(e) => setRuntimeOverride(e.target.value)}
				disabled={rewakeMutation.isPending}
				aria-label="Runtime for re-wake"
				className="flex h-9 rounded-md border bg-(--color-card) px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring) disabled:cursor-not-allowed disabled:opacity-60"
			>
				<option value="pi-chat">pi-chat</option>
				<option value="claude-code-chat">claude-code-chat</option>
			</select>
			<Button
				type="button"
				size="sm"
				variant="outline"
				disabled={rewakeMutation.isPending}
				onClick={() => rewakeMutation.mutate()}
			>
				{rewakeMutation.isPending ? "Re-waking…" : "Re-wake"}
			</Button>
		</>
	);
}
