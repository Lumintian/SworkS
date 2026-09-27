import { splitTagPath } from '@shared/tagPath';

/** 标签显示最后一段，上级路径淡色显示（例如 方法/换元）。 */
export function TagLabel({ name }: { name: string }) {
  const segs = splitTagPath(name);
  if (segs.length <= 1) return <>{name}</>;
  return (
    <>
      <span className="opacity-60">{segs.slice(0, -1).join('/')}/</span>
      {segs.at(-1)}
    </>
  );
}
