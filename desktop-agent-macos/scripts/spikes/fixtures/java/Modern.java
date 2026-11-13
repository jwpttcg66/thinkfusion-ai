package com.acme.modern;

import java.util.List;
import java.util.Optional;

public class Modern {
    public String textBlock() {
        return """
                hello
                java
                """;
    }

    public int varAndPattern(Object value) {
        var values = List.of(1, 2, 3);
        if (value instanceof String text) {
            return text.length() + values.size();
        }
        return values.size();
    }

    public Optional<String> optional(String input) {
        return Optional.ofNullable(input).map(String::trim).filter(item -> !item.isEmpty());
    }
}
