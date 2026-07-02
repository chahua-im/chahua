import 'package:flutter/cupertino.dart';

class MessageOverlayActionV2 {
  const MessageOverlayActionV2({
    required this.label,
    required this.onPressed,
    this.icon,
    this.color,
  });

  final String label;
  final VoidCallback onPressed;
  final IconData? icon;
  final Color? color;
}
