import { onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { Button } from "../ui/Button";

export function ImageLightbox(props: { file: { fileId: string; filename: string }; onClose: () => void }) {
  let closeButton!: HTMLButtonElement;
  let downloadLink!: HTMLAnchorElement;
  const href = () => `/api/media/download/${props.file.fileId}`;

  onMount(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        props.onClose();
      } else if (event.key === "Tab") {
        event.preventDefault();
        const active = document.activeElement;
        const target = event.shiftKey
          ? (active === closeButton ? downloadLink : closeButton)
          : (active === downloadLink ? closeButton : downloadLink);
        target.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    closeButton.focus();
    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    });
  });

  return (
    <Portal>
      <div class="image-lightbox-backdrop" onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}>
        <section class="image-lightbox" role="dialog" aria-modal="true" aria-label={props.file.filename} onClick={(event) => {
          if (event.target === event.currentTarget) props.onClose();
        }}>
          <header class="image-lightbox-toolbar">
            <span class="image-lightbox-name" title={props.file.filename}>{props.file.filename}</span>
            <a ref={downloadLink} class="file-download" href={href()} download="">Download</a>
            <Button ref={closeButton} onClick={props.onClose} aria-label="Close image">Close</Button>
          </header>
          <img class="image-lightbox-image" src={href()} alt={props.file.filename} />
        </section>
      </div>
    </Portal>
  );
}
