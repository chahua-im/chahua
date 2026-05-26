enum MessageSearchSort {
  best('relevance'),
  recent('newest');

  const MessageSearchSort(this.wireValue);

  final String wireValue;
}
