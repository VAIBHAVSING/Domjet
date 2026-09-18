pub mod cdp_watchdog;
mod import_map;
pub mod markdown;
pub mod module_loader;
pub mod ops;
pub mod runtime;
pub mod v8_flags;

pub use markdown::HTML_TO_MARKDOWN_JS;
pub use v8_flags::set_v8_flags;
pub use obscura_dom::resolve_document_base_url;

// Screenshot rasterization (PNG bytes) from the render layer. Available when the
// render feature (which enables obscura-render/paint) is compiled in.
#[cfg(feature = "render")]
pub use obscura_render::{
    css_resource_requests, css_resource_urls, screenshot_png,
    screenshot_png_scrolled,
    screenshot_png_scrolled_at_animation_time,
    screenshot_png_scrolled_at_animation_time_with_surface_color,
    validate_capture_region, AnimationSample, AnimationSampleMode, AnimationSampleTime,
    CaptureError, CaptureRegion, CssMediaType, CssResourceKind, CssResourceRequest,
    ImageRequestProfile,
    MAX_CAPTURE_DIMENSION, MAX_CAPTURE_PIXELS,
};
