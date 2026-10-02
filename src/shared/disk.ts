import { Brand, ByteSize, Data, Option, Schema } from 'effect';
import { statfs } from 'node:fs/promises';

export type Percent = Brand.Branded<number, 'Percent'>;
export const Percent = Brand.check<Percent>(Schema.isBetween({ minimum: 0, maximum: 100 }));

export type DiskLimit = Data.TaggedEnum<{
  Percent: { readonly percent: Percent };
  Bytes: { readonly bytes: ByteSize.ByteSize };
}>;
export const DiskLimit = Data.taggedEnum<DiskLimit>();

export interface DiskUsage {
  readonly path: string;
  readonly total: ByteSize.ByteSize;
  readonly used: ByteSize.ByteSize;
  readonly available: ByteSize.ByteSize;
  readonly usedPercent: Percent;
}

const PERCENT = /^(\d+(?:\.\d+)?)\s*%$/;

export function parseDiskLimit(value: string): DiskLimit {
  const percentMatch = PERCENT.exec(value.trim());
  if (percentMatch) {
    const percent = Percent.option(Number(percentMatch[1]));
    if (Option.isNone(percent)) {
      throw new Error('a percentage between 0% and 100%');
    }
    return DiskLimit.Percent({ percent: percent.value });
  }

  const bytes = ByteSize.fromString(value);
  if (Option.isNone(bytes)) {
    throw new Error('a percentage like 80% or a size like 60GiB');
  }
  return DiskLimit.Bytes({ bytes: bytes.value });
}

export function formatDiskLimit(limit: DiskLimit): string {
  return DiskLimit.$match(limit, {
    Percent: ({ percent }) => `${percent}%`,
    Bytes: ({ bytes }) => formatBytes(bytes),
  });
}

export async function diskUsage(path: string): Promise<DiskUsage> {
  const stats = await statfs(path, { bigint: true });
  const total = stats.blocks * stats.bsize;
  const used = (stats.blocks - stats.bfree) * stats.bsize;
  const available = stats.bavail * stats.bsize;
  const usedPercent = used + available === 0n ? 0 : (Number(used) / Number(used + available)) * 100;
  return {
    path,
    total: ByteSize.bytes(total),
    used: ByteSize.bytes(used),
    available: ByteSize.bytes(available),
    usedPercent: Percent(usedPercent),
  };
}

export function exceedsDiskLimit(usage: DiskUsage, limit: DiskLimit): boolean {
  return DiskLimit.$match(limit, {
    Percent: ({ percent }) => usage.usedPercent >= percent,
    Bytes: ({ bytes }) => ByteSize.isGreaterThanOrEqualTo(usage.used, bytes),
  });
}

export function formatDiskUsage(usage: DiskUsage): string {
  return `${usage.path}: ${formatBytes(usage.used)} of ${formatBytes(usage.total)} used (${usage.usedPercent.toFixed(1)}%), ${formatBytes(usage.available)} available`;
}

export function formatBytes(bytes: ByteSize.ByteSize): string {
  return ByteSize.format(bytes, { system: 'binary', precision: 1 });
}
