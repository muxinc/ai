import type { WorkflowCredentialsInput } from "../types.ts";

import { getMuxThumbnailBaseUrl } from "./mux-url.ts";
import { signUrl } from "./url-signing.ts";
import type { ResolvedWorkflowScope } from "./workflow-scope.ts";

export function* intervalThumbnailTimestamps(
  { startTime, endTime }: ResolvedWorkflowScope,
  interval: number,
  scoped: boolean,
): Generator<number> {
  const duration = endTime - startTime;
  if (duration <= 50) {
    const spacing = duration / 6;
    for (let index = 1; index <= 5; index++) {
      const time = startTime + index * spacing;
      yield scoped ? Number(time.toFixed(3)) : Math.round(time);
    }
    return;
  }

  for (let time = startTime; time < endTime; time += interval) {
    yield time;
    if (!(time + interval > time)) {
      break;
    }
  }
}

export async function getThumbnailUrlsFromTimestamps(
  playbackId: string,
  timestamps: number[],
  { width, shouldSign, credentials }: {
    width: number;
    shouldSign: boolean;
    credentials?: WorkflowCredentialsInput;
  },
): Promise<Array<{ url: string; time: number }>> {
  "use step";
  const baseUrl = await getMuxThumbnailBaseUrl(playbackId, credentials);
  const urls = timestamps.map(async (time) => {
    const url = shouldSign ?
        await signUrl(baseUrl, playbackId, "thumbnail", { time, width }, credentials) :
      `${baseUrl}?time=${time}&width=${width}`;

    return { url, time };
  });
  return Promise.all(urls);
}
