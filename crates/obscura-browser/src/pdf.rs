//! Bounded raster-backed PDF export over the retained document-space painter.
//!
//! This deliberately does not claim CSS paged-media support. It preserves the
//! print-media layout, fits the full document width into the printable area,
//! and slices that immutable layout vertically across PDF pages.

pub use obscura_render::pdf::{
    RasterPdfError, RasterPdfOptions, RasterPdfPageRange,
};
use obscura_render::raster_pdf_from_png_capture;
#[cfg(test)]
use obscura_render::pdf::{
    encode_pdf_pages, pagination_plan, selected_page_indices, validate_selected_raster_work,
    PdfWriter, RasterPage, MAX_PDF_DOCUMENT_PAGES, MAX_PDF_PAGES, POINTS_PER_INCH,
};

use crate::Page;

impl Page {
    /// Export the current print-media layout as a paginated raster PDF.
    ///
    /// The full document width is scaled uniformly into the printable width;
    /// vertical slices become pages. Print media rules participate in normal
    /// cascade and layout, but CSS paged media, headers, and footers remain
    /// outside this raster-backed exporter.
    pub fn raster_pdf(&self, options: RasterPdfOptions) -> Result<Vec<u8>, RasterPdfError> {
        self.raster_pdf_with_animation_sample(options, self.live_animation_sample())
    }

    pub fn raster_pdf_at_animation_time(
        &self,
        options: RasterPdfOptions,
        animation_sample_time: obscura_js::AnimationSampleTime,
    ) -> Result<Vec<u8>, RasterPdfError> {
        self.raster_pdf_with_animation_sample(
            options,
            obscura_js::AnimationSample {
                time: animation_sample_time,
                mode: obscura_js::AnimationSampleMode::LocalOverride,
            },
        )
    }

    pub fn raster_pdf_with_animation_sample(
        &self,
        options: RasterPdfOptions,
        animation_sample: obscura_js::AnimationSample,
    ) -> Result<Vec<u8>, RasterPdfError> {
        let js = self
            .js
            .as_ref()
            .ok_or(RasterPdfError::NoRenderableDocument)?;
        if !js.set_animation_sample(animation_sample) {
            return Err(RasterPdfError::NoRenderableDocument);
        }
        let previous_media = js.set_render_media(obscura_js::CssMediaType::Print);
        let result = (|| {
            let (content_width, content_height) = js
                .prepared_content_size()
                .ok_or(RasterPdfError::NoRenderableDocument)?;
            raster_pdf_from_png_capture(
                &options,
                content_width,
                content_height,
                |region, print_background| {
                    js
                        .screenshot_prepared_region_at_scroll_with_backgrounds(
                            region,
                            (region.x, region.y),
                            print_background,
                        )
                        .map_err(|error| RasterPdfError::CaptureFailed(format!("{error:?}")))
                },
            )
        })();
        js.set_render_media(previous_media);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    /// Decode the actual JPEG XObjects emitted into the PDF, rather than
    /// trusting pagination options or writer-internal page counters.
    fn pdf_page_rasters(pdf: &[u8]) -> Vec<image::RgbImage> {
        let mut pages = Vec::new();
        let mut cursor = 0usize;
        while let Some(relative) = find_bytes(&pdf[cursor..], b"/Subtype /Image") {
            let image_object = cursor + relative;
            let length_key = image_object
                + find_bytes(&pdf[image_object..], b"/Length ").expect("image /Length");
            let mut digits_start = length_key + b"/Length ".len();
            while pdf[digits_start].is_ascii_whitespace() {
                digits_start += 1;
            }
            let mut digits_end = digits_start;
            while pdf[digits_end].is_ascii_digit() {
                digits_end += 1;
            }
            let length = std::str::from_utf8(&pdf[digits_start..digits_end])
                .expect("ASCII image length")
                .parse::<usize>()
                .expect("numeric image length");
            let stream_start = digits_end
                + find_bytes(&pdf[digits_end..], b"stream\n").expect("image stream")
                + b"stream\n".len();
            let stream_end = stream_start.checked_add(length).expect("bounded stream end");
            let raster = image::load_from_memory_with_format(
                &pdf[stream_start..stream_end],
                image::ImageFormat::Jpeg,
            )
            .expect("decodable page JPEG")
            .into_rgb8();
            pages.push(raster);
            cursor = stream_end;
        }
        pages
    }

    fn channel_near(actual: image::Rgb<u8>, expected: [u8; 3]) -> bool {
        actual
            .0
            .into_iter()
            .zip(expected)
            .all(|(actual, expected)| (i16::from(actual) - i16::from(expected)).abs() <= 20)
    }

    #[test]
    fn options_reject_impossible_media_boxes() {
        let mut options = RasterPdfOptions::default();
        options.paper_width_in = 0.0;
        assert_eq!(
            options.page_geometry(),
            Err(RasterPdfError::InvalidPaperSize)
        );
        let mut options = RasterPdfOptions::default();
        options.margin_left_in = 5.0;
        options.margin_right_in = 5.0;
        assert_eq!(options.page_geometry(), Err(RasterPdfError::InvalidMargins));
    }

    #[test]
    fn pagination_preflight_bounds_pages_and_raster_work() {
        let (_, _, printable_width, printable_height, _, _) =
            RasterPdfOptions::default().page_geometry().unwrap();
        let ordinary = pagination_plan(1280.0, 10_000.0, printable_width, printable_height, 1.0)
            .expect("an ordinary multi-page document stays inside the budget");
        assert!(ordinary.page_count > 1);
        let ordinary_pages = selected_page_indices(ordinary.page_count, &[]).unwrap();
        validate_selected_raster_work(1280.0, 10_000.0, ordinary, &ordinary_pages).unwrap();

        let oversized_page =
            pagination_plan(5_000.0, 5_000.0, printable_width, printable_height, 1.0).unwrap();
        let oversized_page_selection =
            selected_page_indices(oversized_page.page_count, &[]).unwrap();
        assert_eq!(
            validate_selected_raster_work(
                5_000.0,
                5_000.0,
                oversized_page,
                &oversized_page_selection,
            )
            .unwrap_err(),
            RasterPdfError::RasterWorkLimitExceeded,
            "one excessively large raster page must fail before capture"
        );

        let too_much_total =
            pagination_plan(1_000.0, 70_000.0, printable_width, printable_height, 1.0).unwrap();
        let too_much_total_selection =
            selected_page_indices(too_much_total.page_count, &[]).unwrap();
        assert_eq!(
            validate_selected_raster_work(
                1_000.0,
                70_000.0,
                too_much_total,
                &too_much_total_selection,
            )
            .unwrap_err(),
            RasterPdfError::RasterWorkLimitExceeded,
            "many individually valid pages must still respect a total work budget"
        );

        let too_many =
            pagination_plan(1_000.0, 400_000.0, printable_width, printable_height, 1.0).unwrap();
        assert_eq!(
            selected_page_indices(too_many.page_count, &[]).unwrap_err(),
            RasterPdfError::TooManyPages(MAX_PDF_PAGES),
        );
    }

    #[test]
    fn selected_ranges_alone_determine_output_and_raster_budgets() {
        let (_, _, printable_width, printable_height, _, _) =
            RasterPdfOptions::default().page_geometry().unwrap();
        let long =
            pagination_plan(1_000.0, 400_000.0, printable_width, printable_height, 1.0).unwrap();
        assert!(long.page_count > MAX_PDF_PAGES);
        let selected = selected_page_indices(
            long.page_count,
            &[RasterPdfPageRange {
                start: Some(1),
                end: Some(1),
            }],
        )
        .unwrap();
        assert_eq!(selected, vec![0]);
        validate_selected_raster_work(1_000.0, 400_000.0, long, &selected).unwrap();

        assert_eq!(
            selected_page_indices(
                long.page_count,
                &[RasterPdfPageRange {
                    start: Some(1),
                    end: Some(MAX_PDF_PAGES + 1),
                }],
            ),
            Err(RasterPdfError::TooManyPages(MAX_PDF_PAGES))
        );

        let base = pagination_plan(800.0, 2_000.0, printable_width, printable_height, 1.0)
            .expect("base geometry");
        let impossible_height =
            base.css_page_height * (MAX_PDF_DOCUMENT_PAGES as f32 + 16.0);
        assert_eq!(
            pagination_plan(
                800.0,
                impossible_height,
                printable_width,
                printable_height,
                1.0,
            )
            .unwrap_err(),
            RasterPdfError::TooManyPages(MAX_PDF_DOCUMENT_PAGES)
        );
    }

    #[test]
    fn scale_changes_css_page_span_and_rejects_invalid_values() {
        let (_, _, printable_width, printable_height, _, _) =
            RasterPdfOptions::default().page_geometry().unwrap();
        let normal =
            pagination_plan(800.0, 2_000.0, printable_width, printable_height, 1.0).unwrap();
        let enlarged =
            pagination_plan(800.0, 2_000.0, printable_width, printable_height, 2.0).unwrap();
        assert_eq!(
            enlarged.points_per_css_pixel,
            normal.points_per_css_pixel * 2.0
        );
        assert_eq!(enlarged.css_page_height, normal.css_page_height / 2.0);
        assert!(enlarged.page_count >= normal.page_count);
        assert_eq!(
            pagination_plan(800.0, 2_000.0, printable_width, printable_height, 0.09,)
                .unwrap_err(),
            RasterPdfError::InvalidScale
        );
    }

    #[test]
    fn page_ranges_clip_deduplicate_and_preserve_document_order() {
        assert_eq!(selected_page_indices(4, &[]).unwrap(), vec![0, 1, 2, 3]);
        assert_eq!(
            selected_page_indices(
                6,
                &[
                    RasterPdfPageRange {
                        start: Some(3),
                        end: Some(5),
                    },
                    RasterPdfPageRange {
                        start: Some(1),
                        end: Some(3),
                    },
                    RasterPdfPageRange {
                        start: Some(5),
                        end: None,
                    },
                ],
            )
            .unwrap(),
            vec![0, 1, 2, 3, 4, 5]
        );
        assert_eq!(
            selected_page_indices(
                6,
                &[RasterPdfPageRange {
                    start: None,
                    end: Some(2),
                }],
            )
            .unwrap(),
            vec![0, 1]
        );
        assert_eq!(
            selected_page_indices(
                3,
                &[RasterPdfPageRange {
                    start: Some(9),
                    end: Some(12),
                }],
            ),
            Err(RasterPdfError::EmptyPageRange)
        );
    }

    #[test]
    fn raster_pdf_repeats_fixed_content_and_advances_flow_on_every_selected_page() {
        let context = std::sync::Arc::new(crate::BrowserContext::new("pdf-fixed".to_string()));
        let mut page = crate::Page::new("pdf-fixed-page".to_string(), context);
        page.set_viewport((100.0, 80.0));
        let dom = obscura_dom::parse_html(
            r#"<html style="margin:0"><body style="margin:0;width:100px;height:200px">
                <div style="position:fixed;z-index:5;left:0;top:0;width:20px;height:10px;background:#111"></div>
                <div style="height:80px;background:#e02020"></div>
                <div style="height:80px;background:#20c040"></div>
                <div style="height:40px;background:#2050e0"></div>
            </body></html>"#,
        );
        let mut runtime = obscura_js::runtime::ObscuraJsRuntime::new();
        runtime.set_dom(dom);
        runtime.set_url("https://example.test/pdf-fixed");
        runtime.set_viewport(100.0, 80.0);
        runtime.run_page_init();
        page.js = Some(runtime);

        let options = RasterPdfOptions {
            print_background: true,
            paper_width_in: 100.0 / POINTS_PER_INCH,
            paper_height_in: 80.0 / POINTS_PER_INCH,
            margin_top_in: 0.0,
            margin_bottom_in: 0.0,
            margin_left_in: 0.0,
            margin_right_in: 0.0,
            ..RasterPdfOptions::default()
        };
        let pdf = page.raster_pdf(options.clone()).expect("three-page PDF");
        assert!(String::from_utf8_lossy(&pdf).contains("/MediaBox [0 0 100.000 80.000]"));
        let rasters = pdf_page_rasters(&pdf);
        assert_eq!(rasters.len(), 3);
        assert_eq!(rasters[0].dimensions(), (100, 80));
        assert_eq!(rasters[1].dimensions(), (100, 80));
        assert_eq!(
            rasters[2].dimensions(),
            (100, 40),
            "the final partial page must use its own virtual viewport height"
        );
        for (index, raster) in rasters.iter().enumerate() {
            assert!(
                channel_near(*raster.get_pixel(5, 5), [17, 17, 17]),
                "fixed header missing from decoded page {}: {:?}",
                index + 1,
                raster.get_pixel(5, 5)
            );
        }
        for (index, expected) in [[224, 32, 32], [32, 192, 64], [32, 80, 224]]
            .into_iter()
            .enumerate()
        {
            let raster = &rasters[index];
            assert!(
                channel_near(
                    *raster.get_pixel(raster.width() / 2, raster.height() / 2),
                    expected,
                ),
                "ordinary flow did not advance on page {}",
                index + 1,
            );
        }
        assert_eq!(
            page.js.as_ref().expect("runtime").scroll_offset(),
            (0.0, 0.0),
            "virtual PDF page scrolling must not mutate the live page"
        );

        let mut ranged = options;
        ranged.page_ranges = vec![RasterPdfPageRange {
            start: Some(2),
            end: Some(3),
        }];
        let selected = pdf_page_rasters(&page.raster_pdf(ranged).expect("selected pages"));
        assert_eq!(selected.len(), 2);
        assert!(channel_near(*selected[0].get_pixel(5, 5), [17, 17, 17]));
        assert!(channel_near(*selected[1].get_pixel(5, 5), [17, 17, 17]));
        assert!(channel_near(*selected[0].get_pixel(50, 40), [32, 192, 64]));
        assert!(channel_near(*selected[1].get_pixel(50, 20), [32, 80, 224]));
    }

    #[test]
    fn raster_pdf_selects_print_media_and_restores_screen_render_state() {
        let context = std::sync::Arc::new(crate::BrowserContext::new("pdf-media".to_string()));
        let mut page = crate::Page::new("pdf-media-page".to_string(), context);
        page.set_viewport((100.0, 80.0));
        let dom = obscura_dom::parse_html(
            r#"<!doctype html><html><head>
                <style>
                    html,body{margin:0;width:100px;height:80px;background:#101010}
                    #print-marker,#screen-marker{display:none}
                    @media print {
                        body{background:#2050e0}
                    }
                    @media screen {
                        body{background:#e02020}
                    }
                </style>
                <style media="print">
                    #print-marker{display:block;position:absolute;left:60px;top:10px;
                                  width:30px;height:30px;background:#f0d020}
                </style>
                <style media="screen">
                    #screen-marker{display:block;position:absolute;left:5px;top:5px;
                                   width:10px;height:10px;background:#20c040}
                </style>
            </head><body><div id="print-marker"></div><div id="screen-marker"></div></body></html>"#,
        );
        let mut runtime = obscura_js::runtime::ObscuraJsRuntime::new();
        runtime.set_dom(dom);
        runtime.set_url("https://example.test/pdf-media");
        runtime.set_viewport(100.0, 80.0);
        runtime.run_page_init();
        page.js = Some(runtime);

        let screen_before = page.screenshot((100.0, 80.0)).expect("screen before PDF");
        let screen_before_pixels =
            image::load_from_memory_with_format(&screen_before, image::ImageFormat::Png)
                .expect("screen PNG")
                .into_rgb8();
        assert_eq!(screen_before_pixels.get_pixel(50, 60).0, [224, 32, 32]);
        assert_eq!(screen_before_pixels.get_pixel(8, 8).0, [32, 192, 64]);
        assert_eq!(
            screen_before_pixels.get_pixel(70, 20).0,
            [224, 32, 32],
            "media=print marker must stay out of the screen cascade"
        );

        let options = RasterPdfOptions {
            print_background: true,
            paper_width_in: 100.0 / POINTS_PER_INCH,
            paper_height_in: 80.0 / POINTS_PER_INCH,
            margin_top_in: 0.0,
            margin_bottom_in: 0.0,
            margin_left_in: 0.0,
            margin_right_in: 0.0,
            ..RasterPdfOptions::default()
        };
        let pages = pdf_page_rasters(&page.raster_pdf(options).expect("print-media PDF"));
        assert_eq!(pages.len(), 1);
        let printed = &pages[0];
        assert!(
            channel_near(*printed.get_pixel(50, 60), [32, 80, 224]),
            "@media print body color missing: {:?}",
            printed.get_pixel(50, 60)
        );
        assert!(
            channel_near(*printed.get_pixel(70, 20), [240, 208, 32]),
            "media=print stylesheet marker missing: {:?}",
            printed.get_pixel(70, 20)
        );
        assert!(
            channel_near(*printed.get_pixel(8, 8), [32, 80, 224]),
            "media=screen marker leaked into print: {:?}",
            printed.get_pixel(8, 8)
        );

        let screen_after = page.screenshot((100.0, 80.0)).expect("screen after PDF");
        assert_eq!(
            screen_after, screen_before,
            "temporary print cascade must not poison retained screen geometry or stylesheet cache"
        );
    }

    #[test]
    fn writer_emits_xref_and_one_image_per_page() {
        let pdf = encode_pdf_pages(1, 612.0, 792.0, 36.0, 36.0, 720.0, |_| {
            Ok(RasterPage {
                rgb: image::RgbImage::from_pixel(2, 3, image::Rgb([10, 20, 30])),
                draw_width_pt: 100.0,
                draw_height_pt: 150.0,
                _lifetime_probe: None,
            })
        })
        .unwrap();
        assert!(pdf.starts_with(b"%PDF-1.4"));
        assert!(pdf.ends_with(b"%%EOF\n"));
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/Count 1"));
        assert!(text.contains("/Subtype /Image"));
        assert!(text.contains("xref\n0 6"));
        let startxref = text
            .rsplit_once("startxref\n")
            .unwrap()
            .1
            .lines()
            .next()
            .unwrap()
            .parse::<usize>()
            .unwrap();
        assert!(pdf[startxref..].starts_with(b"xref\n"));
        let object_one_offset = text
            .split("xref\n0 6\n")
            .nth(1)
            .unwrap()
            .lines()
            .nth(1)
            .unwrap()[..10]
            .parse::<usize>()
            .unwrap();
        assert!(pdf[object_one_offset..].starts_with(b"1 0 obj\n"));
    }

    #[test]
    fn page_rasters_are_released_before_capturing_the_next_page() {
        let previous = std::cell::RefCell::new(None::<std::rc::Weak<()>>);
        let pdf = encode_pdf_pages(4, 612.0, 792.0, 36.0, 36.0, 720.0, |index| {
            if let Some(previous) = previous.borrow().as_ref() {
                assert!(
                    previous.upgrade().is_none(),
                    "page {index} was requested while the prior raster was still retained"
                );
            }
            let probe = std::rc::Rc::new(());
            *previous.borrow_mut() = Some(std::rc::Rc::downgrade(&probe));
            Ok(RasterPage {
                rgb: image::RgbImage::from_pixel(8, 8, image::Rgb([index as u8, 0, 0])),
                draw_width_pt: 100.0,
                draw_height_pt: 100.0,
                _lifetime_probe: Some(probe),
            })
        })
        .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&pdf)
                .matches("/Subtype /Image")
                .count(),
            4
        );
    }

    #[test]
    fn writer_enforces_the_output_limit_while_encoding_the_image_stream() {
        let mut writer = PdfWriter::new(5, 600).unwrap();
        writer
            .write_object(1, b"<< /Type /Catalog /Pages 2 0 R >>")
            .unwrap();
        writer
            .write_object(2, b"<< /Type /Pages /Count 1 /Kids [3 0 R] >>")
            .unwrap();
        let noisy = image::RgbImage::from_fn(128, 128, |x, y| {
            image::Rgb([
                x.wrapping_mul(37) as u8,
                y.wrapping_mul(53) as u8,
                x.wrapping_add(y).wrapping_mul(71) as u8,
            ])
        });
        assert_eq!(
            writer.write_rgb_image(5, &noisy),
            Err(RasterPdfError::OutputLimitExceeded)
        );
        assert!(writer.output.len() <= 600);
    }
}
