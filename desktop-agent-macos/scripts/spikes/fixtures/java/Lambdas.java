package com.acme.functional;

import java.util.List;
import java.util.function.Function;
import java.util.function.Supplier;

public class Lambdas {
    public List<String> map(List<Integer> values) {
        Function<Integer, String> render = value -> "v=" + value;
        return values.stream().map(render).toList();
    }

    public String supplier() {
        Supplier<String> supplier = this::toString;
        return supplier.get();
    }

    public int sum(List<Integer> values) {
        return values.stream().mapToInt(Integer::intValue).sum();
    }
}
