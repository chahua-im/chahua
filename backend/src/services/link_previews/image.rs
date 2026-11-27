use std::io::Cursor;

use image::{
    error::{DecodingError, ImageFormatHint, LimitError, LimitErrorKind},
    imageops::FilterType,
    DynamicImage, ImageDecoder, ImageError, ImageFormat, ImageReader, Limits,
};

const MAX_DIMENSION: u32 = 4096;
const MAX_PIXELS: u64 = 4_000_000;
const MAX_ALLOC: u64 = 64 * 1024 * 1024;
const THUMBNAIL_DIMENSION: u32 = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thumbnail {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

fn invalid_webp() -> ImageError {
    ImageError::Decoding(DecodingError::new(
        ImageFormatHint::Exact(ImageFormat::WebP),
        std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid WebP frame"),
    ))
}

fn next_chunk<'a>(data: &mut &'a [u8]) -> Option<Option<(&'a [u8], &'a [u8])>> {
    if data.is_empty() {
        return Some(None);
    }
    let input = *data;
    let header = input.get(..8)?;
    let size = u32::from_le_bytes(header[4..8].try_into().ok()?) as usize;
    let padded = size.checked_add(size & 1)?;
    let payload = input.get(8..8usize.checked_add(size)?)?;
    *data = input.get(8usize.checked_add(padded)?..)?;
    Some(Some((&header[..4], payload)))
}

fn find_frame(mut data: &[u8]) -> Option<(&[u8], &[u8])> {
    let mut frame = None;
    while let Some((kind, payload)) = next_chunk(&mut data)? {
        if kind == b"VP8 " || kind == b"VP8L" {
            if frame.is_some() {
                return None;
            }
            frame = Some((kind, payload));
        }
    }
    frame
}

fn frame_dimensions(kind: &[u8], data: &[u8]) -> Option<(u32, u32)> {
    match kind {
        b"VP8 " => {
            let header = data.get(..10)?;
            if header[0] & 1 != 0 || header[3..6] != [0x9d, 0x01, 0x2a] {
                return None;
            }
            Some((
                u32::from(u16::from_le_bytes(header[6..8].try_into().ok()?) & 0x3fff),
                u32::from(u16::from_le_bytes(header[8..10].try_into().ok()?) & 0x3fff),
            ))
        }
        b"VP8L" => {
            let header = data.get(..5)?;
            let bits = u32::from_le_bytes(header[1..5].try_into().ok()?);
            if header[0] != 0x2f || bits >> 29 != 0 {
                return None;
            }
            Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        _ => None,
    }
}

fn u24(data: &[u8]) -> Option<u32> {
    Some(
        u32::from(*data.first()?)
            | (u32::from(*data.get(1)?) << 8)
            | (u32::from(*data.get(2)?) << 16),
    )
}

// The decoder exposes the VP8X canvas before inspecting the compressed frame.
// Check the actual first frame before it can allocate from attacker-controlled dimensions.
fn validate_webp_frame(bytes: &[u8]) -> Option<()> {
    if bytes.get(..4)? != b"RIFF" || bytes.get(8..12)? != b"WEBP" {
        return None;
    }
    let riff_size = u32::from_le_bytes(bytes.get(4..8)?.try_into().ok()?) as usize;
    let mut body = bytes.get(12..riff_size.checked_add(8)?)?;
    let (kind, data) = next_chunk(&mut body)??;
    let (canvas, frame, image_parts) = if kind == b"VP8X" {
        let header = data.get(..10)?;
        let canvas = (u24(&header[4..7])? + 1, u24(&header[7..10])? + 1);
        if header[0] & 2 != 0 {
            let mut rest = body;
            let mut first_frame = None;
            while let Some((kind, payload)) = next_chunk(&mut rest)? {
                if kind == b"ANMF" && first_frame.is_none() {
                    first_frame = Some(payload);
                }
            }
            let animation = first_frame?;
            let h = animation.get(..16)?;
            let x = u24(&h[0..3])?.checked_mul(2)?;
            let y = u24(&h[3..6])?.checked_mul(2)?;
            let frame = (u24(&h[6..9])? + 1, u24(&h[9..12])? + 1);
            if x.checked_add(frame.0)? > canvas.0 || y.checked_add(frame.1)? > canvas.1 {
                return None;
            }
            (canvas, frame, find_frame(animation.get(16..)?)?)
        } else {
            (canvas, canvas, find_frame(body)?)
        }
    } else {
        let dims = frame_dimensions(kind, data)?;
        (dims, dims, (kind, data))
    };
    if canvas.0 == 0
        || canvas.1 == 0
        || canvas.0 > MAX_DIMENSION
        || canvas.1 > MAX_DIMENSION
        || u64::from(canvas.0) * u64::from(canvas.1) > MAX_PIXELS
    {
        return None;
    }
    if frame_dimensions(image_parts.0, image_parts.1)? != frame {
        return None;
    }
    Some(())
}

/// Decode only the first frame and re-encode it, without retaining source metadata.
pub fn thumbnail(bytes: &[u8]) -> Result<Thumbnail, ImageError> {
    let format = image::guess_format(bytes)?;
    if !matches!(
        format,
        ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::Gif | ImageFormat::WebP
    ) {
        return Err(ImageError::Unsupported(
            image::error::ImageFormatHint::Exact(format).into(),
        ));
    }
    if format == ImageFormat::WebP {
        validate_webp_frame(bytes).ok_or_else(invalid_webp)?;
    }

    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_ALLOC);

    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits.clone());
    let mut decoder = reader.into_decoder()?;
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(ImageError::Limits(LimitError::from_kind(
            LimitErrorKind::DimensionError,
        )));
    }
    // Reserve the output buffer as ImageReader::decode does. Upstream WebP does
    // not enforce this allowance for every internal allocation.
    limits.reserve(decoder.total_bytes())?;
    decoder.set_limits(limits)?;
    let image = DynamicImage::from_decoder(decoder)?;
    let image = if width > THUMBNAIL_DIMENSION || height > THUMBNAIL_DIMENSION {
        image.resize(
            THUMBNAIL_DIMENSION,
            THUMBNAIL_DIMENSION,
            FilterType::Lanczos3,
        )
    } else {
        image
    };
    let width = image.width();
    let height = image.height();
    let mut encoded = Cursor::new(Vec::new());
    image.write_to(&mut encoded, ImageFormat::WebP)?;
    Ok(Thumbnail {
        bytes: encoded.into_inner(),
        width,
        height,
    })
}

#[cfg(test)]
mod tests;
