export type ThumbnailProps = {
  src: string;
  alt: string;
  size: number;
  onOpen: (src: string) => void;
};

const altText = (alt: string): string => (alt.trim() === "" ? "untitled photo" : alt);

export const Thumbnail = ({ src, alt, size, onOpen }: ThumbnailProps) => (
  <button
    className="thumbnail"
    type="button"
    style={{ width: size, height: size }}
    onClick={() => onOpen(src)}
  >
    <img
      src={src}
      alt={altText(alt)}
      width={size}
      height={size}
      loading="lazy"
    />
  </button>
);

export const ThumbnailPlaceholder = ({ size }: { size: number; }) => (
  <div className="thumbnail placeholder" style={{ width: size, height: size }} />
);
