import { MetadataStore } from "../../src/metadata-store.ts";
await new MetadataStore(process.argv[2], 10000).patchProject(process.argv[3], { pinned: true });
