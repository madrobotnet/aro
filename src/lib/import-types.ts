export type ImportPreview = {
  readonly digest: string;
  readonly notes: readonly { readonly path: string; readonly title: string }[];
  readonly attachments: number;
  readonly warnings: readonly { readonly path: string; readonly code: string; readonly detail: string }[];
  readonly conflicts: readonly { readonly path: string; readonly title: string; readonly reason: string }[];
  readonly canCommit: boolean;
};

export type ImportReceipt = {
  readonly status: "imported";
  readonly notes: readonly { readonly path: string; readonly id: string; readonly title: string }[];
  readonly attachments: number;
  readonly warnings: ImportPreview["warnings"];
};
