package com.acme.order;

import java.util.List;
import static java.util.Objects.requireNonNull;

/**
 * Gate 0 Tree-sitter fixture: package, static import, class, fields,
 * constructor, methods, calls and object creation.
 */
public class OrderService extends BaseService implements OrderPort {
    private final OrderRepository repository;
    private static final int MAX_BATCH = 10;

    public OrderService(OrderRepository repository) {
        this.repository = requireNonNull(repository);
    }

    @Override
    public void create(String id) {
        validate(id);
        repository.save(id);
        new AuditLog().record(id);
    }

    private void validate(String id) {
        if (id == null || id.isBlank()) {
            throw new IllegalArgumentException("id required");
        }
    }

    public List<String> list() {
        return repository.findAll();
    }
}
