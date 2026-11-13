package com.acme.records;

public record Records<T>(T value, int count) implements Comparable<Records<T>> {
    public Records {
        if (count < 0) {
            throw new IllegalArgumentException("count");
        }
    }

    @Override
    public int compareTo(Records<T> other) {
        return Integer.compare(count, other.count);
    }

    record Pair<A, B>(A left, B right) {
    }
}
