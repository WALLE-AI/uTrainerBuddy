"""Fixed validation accuracy for the synthetic classifier recipe."""
def accuracy(probability, validation):
    return sum(int(probability(x, y) >= 0.5) == target
               for (x, y), target in validation) / len(validation)
