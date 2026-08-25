import { useState } from "react";

import { Thumbnail } from "./thumbnail";

export type Photo = {
  src: string;
  alt: string;
};

type GalleryProps = {
  photos: Photo[];
  featured: Photo;
};

export const Gallery = ({ photos, featured }: GalleryProps) => {
  const [openSrc, setOpenSrc] = useState<string | undefined>(undefined);
  const open = (src: string) => setOpenSrc(src);

  return (
    <section className="gallery">
      <Thumbnail src={featured.src} alt={featured.alt} size={240} onOpen={open} />
      {photos.map(photo => (
        <Thumbnail key={photo.src} src={photo.src} alt={photo.alt} size={96} onOpen={open} />
      ))}
      {openSrc !== undefined && (
        <img className="lightbox" src={openSrc} alt="" onClick={() => setOpenSrc(undefined)} />
      )}
    </section>
  );
};
