package com.acme.generic;

import java.util.List;
import java.util.function.Function;

/** Gate 0 Tree-sitter fixture: generics, overloads, throws, multi-line signature and varargs. */
public class GenericService<T extends Comparable<T>> {
    public <R> List<R> map(
            List<T> input,
            Function<T, R> mapper) throws IllegalStateException {
        return input.stream().map(mapper).toList();
    }

    public void save(String id) {
    }

    public void save(String id, boolean force) {
    }

    public static <V> V identity(V value) {
        return value;
    }

    public void varargs(String... values) {
    }
}
