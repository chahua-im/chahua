import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:file_picker/file_picker.dart';
import 'package:image_picker/image_picker.dart';
import 'package:mime/mime.dart';
import 'package:path/path.dart' as path;
import 'package:video_player/video_player.dart';
import 'package:video_thumbnail/video_thumbnail.dart';

import 'package:chahua/core/platform/native_dialog_focus_guard.dart';

enum ComposerAttachmentKind { image, gif, video }

enum ComposerAttachmentSource { cameraPhoto, mediaLibrary }

class PickedComposerAttachment {
  const PickedComposerAttachment({
    required this.localId,
    required this.file,
    required this.name,
    required this.mimeType,
    required this.kind,
    required this.sizeBytes,
    this.previewBytes,
    this.width,
    this.height,
  });

  final String localId;
  final PlatformFile file;
  final String name;
  final String mimeType;
  final ComposerAttachmentKind kind;
  final int sizeBytes;
  final Uint8List? previewBytes;
  final int? width;
  final int? height;
}

class AttachmentPickerService {
  AttachmentPickerService({
    ImagePicker? imagePicker,
    NativeDialogFocusGuard nativeDialogFocusGuard =
        const NativeDialogFocusGuard(),
  }) : _imagePicker = imagePicker ?? ImagePicker(),
       _nativeDialogFocusGuard = nativeDialogFocusGuard;

  final ImagePicker _imagePicker;
  final NativeDialogFocusGuard _nativeDialogFocusGuard;

  Future<List<PickedComposerAttachment>> pick(
    ComposerAttachmentSource source,
  ) async {
    return switch (source) {
      ComposerAttachmentSource.cameraPhoto => _pickCameraPhoto(),
      ComposerAttachmentSource.mediaLibrary => _pickMediaLibrary(),
    };
  }

  Future<List<PickedComposerAttachment>> _pickCameraPhoto() async {
    await _nativeDialogFocusGuard.prepareForNativeDialog();
    final photo = await _imagePicker.pickImage(source: ImageSource.camera);
    if (photo == null) {
      return const <PickedComposerAttachment>[];
    }
    return _toPickedAttachments(<XFile>[
      photo,
    ], ComposerAttachmentSource.cameraPhoto);
  }

  Future<List<PickedComposerAttachment>> _pickMediaLibrary() async {
    await _nativeDialogFocusGuard.prepareForNativeDialog();
    final media = await _imagePicker.pickMultipleMedia();
    return _toPickedAttachments(media, ComposerAttachmentSource.mediaLibrary);
  }

  Future<List<PickedComposerAttachment>> _toPickedAttachments(
    List<XFile> files,
    ComposerAttachmentSource source,
  ) async {
    final attachments = <PickedComposerAttachment>[];
    for (final xFile in files) {
      final platformFile = await _toPlatformFile(xFile);
      final attachment = await _toPickedAttachment(platformFile, source);
      if (attachment != null) {
        attachments.add(attachment);
      }
    }
    return attachments;
  }

  Future<PlatformFile> _toPlatformFile(XFile xFile) async {
    final size = await xFile.length();
    final bytes = await _previewCandidateBytesFor(xFile);
    return PlatformFile(
      name: _fileNameFor(xFile),
      size: size,
      path: xFile.path,
      bytes: bytes,
      readStream: xFile.openRead(),
    );
  }

  Future<Uint8List?> _previewCandidateBytesFor(XFile xFile) async {
    final mimeType =
        lookupMimeType(xFile.path) ??
        lookupMimeType(xFile.name) ??
        xFile.mimeType;
    if (mimeType == null || !mimeType.startsWith('image/')) {
      return null;
    }
    try {
      return await xFile.readAsBytes();
    } catch (_) {
      return null;
    }
  }

  String _fileNameFor(XFile xFile) {
    final name = xFile.name;
    if (name.isNotEmpty) {
      return name;
    }
    return path.basename(xFile.path);
  }

  Future<PickedComposerAttachment?> _toPickedAttachment(
    PlatformFile file,
    ComposerAttachmentSource source,
  ) async {
    final mimeType = _detectMimeType(file, source);
    final kind = _detectKind(file, mimeType, source);
    final previewBytes = await _previewBytesFor(file, kind);
    final dimensions = await _dimensionsFor(file, kind, previewBytes);

    return PickedComposerAttachment(
      localId: _createLocalId(),
      file: file,
      name: file.name,
      mimeType: mimeType,
      kind: kind,
      sizeBytes: file.size,
      previewBytes: previewBytes,
      width: dimensions.$1,
      height: dimensions.$2,
    );
  }

  String _detectMimeType(PlatformFile file, ComposerAttachmentSource source) {
    final detected =
        lookupMimeType(file.path ?? file.name, headerBytes: file.bytes) ??
        lookupMimeType(file.name, headerBytes: file.bytes);
    if (detected != null && detected.isNotEmpty) {
      return detected;
    }
    return switch (source) {
      ComposerAttachmentSource.cameraPhoto => 'image/*',
      ComposerAttachmentSource.mediaLibrary => 'application/octet-stream',
    };
  }

  ComposerAttachmentKind _detectKind(
    PlatformFile file,
    String mimeType,
    ComposerAttachmentSource source,
  ) {
    if (mimeType == 'image/gif' || file.extension?.toLowerCase() == 'gif') {
      return ComposerAttachmentKind.gif;
    }
    if (mimeType.startsWith('image/')) {
      return ComposerAttachmentKind.image;
    }
    if (mimeType.startsWith('video/')) {
      return ComposerAttachmentKind.video;
    }
    return switch (source) {
      ComposerAttachmentSource.cameraPhoto => ComposerAttachmentKind.image,
      ComposerAttachmentSource.mediaLibrary => ComposerAttachmentKind.image,
    };
  }

  Future<Uint8List?> _previewBytesFor(
    PlatformFile file,
    ComposerAttachmentKind kind,
  ) async {
    return switch (kind) {
      ComposerAttachmentKind.image || ComposerAttachmentKind.gif => file.bytes,
      ComposerAttachmentKind.video => _videoPreviewBytesFor(file),
    };
  }

  Future<(int?, int?)> _dimensionsFor(
    PlatformFile file,
    ComposerAttachmentKind kind,
    Uint8List? previewBytes,
  ) async {
    return switch (kind) {
      ComposerAttachmentKind.image ||
      ComposerAttachmentKind.gif => _imageDimensionsFor(previewBytes),
      ComposerAttachmentKind.video => _videoDimensionsFor(file),
    };
  }

  Future<(int?, int?)> _imageDimensionsFor(Uint8List? previewBytes) async {
    if (previewBytes == null) {
      return (null, null);
    }
    try {
      final completer = Completer<ui.Image>();
      ui.decodeImageFromList(previewBytes, completer.complete);
      final image = await completer.future.timeout(const Duration(seconds: 2));
      final size = (image.width, image.height);
      image.dispose();
      return size;
    } catch (_) {
      return (null, null);
    }
  }

  Future<Uint8List?> _videoPreviewBytesFor(PlatformFile file) async {
    final filePath = _localFilePath(file);
    if (filePath == null) {
      return null;
    }
    try {
      return await VideoThumbnail.thumbnailData(
        video: filePath,
        imageFormat: ImageFormat.JPEG,
        maxWidth: 512,
        quality: 70,
      );
    } catch (_) {
      return null;
    }
  }

  Future<(int?, int?)> _videoDimensionsFor(PlatformFile file) async {
    final filePath = _localFilePath(file);
    if (filePath == null) {
      return (null, null);
    }

    final controller = VideoPlayerController.file(File(filePath));
    try {
      await controller.initialize().timeout(const Duration(seconds: 3));
      final size = controller.value.size;
      if (size.width <= 0 || size.height <= 0) {
        return (null, null);
      }
      return (size.width.round(), size.height.round());
    } catch (_) {
      return (null, null);
    } finally {
      await controller.dispose();
    }
  }

  String? _localFilePath(PlatformFile file) {
    if (file.path case final path? when path.isNotEmpty) {
      return path;
    }
    return null;
  }

  String _createLocalId() => DateTime.now().microsecondsSinceEpoch.toString();
}
