/**
 * Reusable responsive YouTube embedded player.
 * Embeds the video directly by its ID. The parent is responsible for
 * the 16:9 aspect ratio box; this component fills it.
 */
export function YouTubePlayer({ videoId, title }: { videoId: string; title: string }) {
  return (
    <iframe
      className="yt-embed"
      src={`https://www.youtube.com/embed/${encodeURIComponent(videoId)}?rel=0`}
      title={title}
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin"
    />
  )
}
