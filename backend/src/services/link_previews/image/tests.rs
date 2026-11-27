use super::*;
use image::{Rgba, RgbaImage};

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    RgbaImage::from_pixel(width, height, Rgba([30, 80, 120, 255]))
        .write_to(&mut bytes, ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

fn chunk(tag: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut chunk = Vec::from(tag.as_slice());
    chunk.extend_from_slice(&(data.len() as u32).to_le_bytes());
    chunk.extend_from_slice(data);
    if !data.len().is_multiple_of(2) {
        chunk.push(0);
    }
    chunk
}

fn webp(chunks: &[Vec<u8>]) -> Vec<u8> {
    let body = chunks.concat();
    let mut result = Vec::from(&b"RIFF"[..]);
    result.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
    result.extend_from_slice(b"WEBP");
    result.extend_from_slice(&body);
    result
}

fn vp8(width: u16, height: u16) -> Vec<u8> {
    let mut header = vec![0, 0, 0, 0x9d, 0x01, 0x2a];
    header.extend_from_slice(&width.to_le_bytes());
    header.extend_from_slice(&height.to_le_bytes());
    chunk(b"VP8 ", &header)
}

fn vp8l(width: u32, height: u32) -> Vec<u8> {
    let mut header = vec![0x2f];
    header.extend_from_slice(&((width - 1) | ((height - 1) << 14)).to_le_bytes());
    chunk(b"VP8L", &header)
}

#[test]
fn link_preview_image_checks_embedded_webp_dimensions_before_decode() {
    let extended = chunk(b"VP8X", &[0; 10]); // one-pixel canvas
    for frame in [vp8(16383, 16383), vp8l(16384, 16384)] {
        let bytes = webp(&[extended.clone(), frame.clone()]);
        assert!(validate_webp_frame(&bytes).is_none());
        assert!(thumbnail(&bytes).is_err());

        for alpha in [false, true] {
            let mut frame_data = vec![0; 16]; // one-pixel animation frame
            if alpha {
                frame_data.extend_from_slice(&chunk(b"ALPH", &[0]));
            }
            frame_data.extend_from_slice(&frame);
            let mut animation_header = [0; 10];
            animation_header[0] = 2;
            let animated = webp(&[
                chunk(b"VP8X", &animation_header),
                chunk(b"ANIM", &[0; 6]),
                chunk(b"ANMF", &frame_data),
            ]);
            assert!(validate_webp_frame(&animated).is_none());
            assert!(thumbnail(&animated).is_err());
        }
    }
    assert!(validate_webp_frame(&webp(&[extended, chunk(b"VP8 ", &[0; 3])])).is_none());
}

#[test]
fn link_preview_image_accepts_valid_webp() {
    let mut source = Cursor::new(Vec::new());
    RgbaImage::from_pixel(20, 40, Rgba([30, 80, 120, 255]))
        .write_to(&mut source, ImageFormat::WebP)
        .unwrap();
    let thumbnail = thumbnail(&source.into_inner()).unwrap();
    assert_eq!((thumbnail.width, thumbnail.height), (20, 40));
}

#[test]
fn link_preview_image_accepts_first_webp_animation_frame() {
    let mut frames = Vec::new();
    for color in [[255, 0, 0, 255], [0, 0, 255, 255]] {
        let mut source = Cursor::new(Vec::new());
        RgbaImage::from_pixel(2, 2, Rgba(color))
            .write_to(&mut source, ImageFormat::WebP)
            .unwrap();
        let source = source.into_inner();
        let mut frame = vec![0; 16];
        frame[6] = 1;
        frame[9] = 1;
        frame.extend_from_slice(&source[12..]);
        frames.push(chunk(b"ANMF", &frame));
    }
    let mut header = [0; 10];
    header[0] = 2;
    header[4] = 1;
    header[7] = 1;
    let animated = webp(&[
        chunk(b"VP8X", &header),
        chunk(b"ANIM", &[0; 6]),
        frames.remove(0),
        frames.remove(0),
    ]);
    let result = thumbnail(&animated).unwrap();
    let decoded = image::load_from_memory(&result.bytes).unwrap().to_rgba8();
    let [red, green, blue, alpha] = decoded.get_pixel(0, 0).0;
    assert!(
        red >= 250 && green <= 5 && blue <= 5 && alpha == 255,
        "only the first (red) frame is rendered"
    );
}

#[test]
fn link_preview_image_rejects_malformed_and_unsupported_formats() {
    assert!(thumbnail(b"not an image").is_err());
    assert!(thumbnail(b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>").is_err());
    assert!(thumbnail(b"\x89PNG\r\n\x1a\ntruncated").is_err());
    assert!(thumbnail(b"GIF89atruncated").is_err());
    assert!(thumbnail(b"BM\0\0\0\0\0\0\0\0\0\0\0\0").is_err());
}

#[test]
fn link_preview_image_rejects_dimension_and_pixel_bombs() {
    assert!(thumbnail(&png(4097, 1)).is_err());
    assert!(thumbnail(&png(1, 4097)).is_err());
    assert!(thumbnail(&png(2001, 2000)).is_err());
}

#[test]
fn link_preview_image_resizes_and_never_upscales() {
    for (source, expected) in [
        ((400, 200), (128, 64)),
        ((20, 40), (20, 40)),
        ((128, 128), (128, 128)),
    ] {
        let result = thumbnail(&png(source.0, source.1)).unwrap();
        assert_eq!((result.width, result.height), expected);
        assert_eq!(
            image::guess_format(&result.bytes).unwrap(),
            ImageFormat::WebP
        );
        let decoded = image::load_from_memory(&result.bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), expected);
    }
}

#[test]
fn link_preview_image_uses_only_first_animation_frame() {
    let mut bytes = Vec::new();
    {
        let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
        for color in [[255, 0, 0, 255], [0, 0, 255, 255]] {
            encoder
                .encode_frame(image::Frame::new(RgbaImage::from_pixel(2, 2, Rgba(color))))
                .unwrap();
        }
    }
    let result = thumbnail(&bytes).unwrap();
    let decoded = image::load_from_memory(&result.bytes).unwrap().to_rgba8();
    assert_eq!(decoded.get_pixel(0, 0).0, [255, 0, 0, 255]);
}
