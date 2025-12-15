(module
 (type $voydOutcome (struct (field $tag i32) (field $payload eqref)))
 (type $voydHandlerFrame (struct (field $prev eqref) (field $effectId i32) (field $opId i32) (field $resumeKind i32) (field $clauseFn funcref) (field $clauseEnv anyref) (field $tailExpected i32) (field $label i32)))
 (type $voydOutcomeValue_0_2 (struct (field $value i32)))
 (type $voydTailGuard (struct (field $expected i32) (field $observed (mut i32))))
 (type $voydContinuation (struct (field $fn funcref) (field $env anyref) (field $site i32)))
 (type $voydEffectRequest (struct (field $effectId i32) (field $opId i32) (field $resumeKind i32) (field $args eqref) (field $cont (ref null $voydContinuation)) (field $tailGuard (ref null $voydTailGuard))))
 (type $voydContEnvBase (sub (struct (field $site i32) (field $handler (ref null $voydHandlerFrame)))))
 (type $voydContEnv__proj_src_effects_continuation_compiler_voyd_while_test_1 (sub final $voydContEnvBase (struct (field $site i32) (field $handler (ref null $voydHandlerFrame)) (field $sum i32) (field $v i32))))
 (type $voydEffectResult (struct (field $status i32) (field $cont anyref)))
 (type $FieldAccessor (sub (struct (field $__field_hash i32) (field $__field_getter funcref) (field $__field_setter funcref))))
 (type $10 (array (mut (ref null $FieldAccessor))))
 (type $11 (func (param anyref eqref) (result (ref null $voydOutcome))))
 (type $MethodAccessor (sub (struct (field $__method_hash i32) (field $__method_ref funcref))))
 (type $13 (array (mut i32)))
 (type $14 (array (mut (ref null $MethodAccessor))))
 (type $15 (func (param i32 (ref null $13)) (result i32)))
 (type $16 (func (param (ref null $voydHandlerFrame)) (result (ref null $voydOutcome))))
 (type $17 (func (param (ref null $voydHandlerFrame) anyref (ref null $voydEffectRequest)) (result (ref null $voydOutcome))))
 (type $18 (func (result i32)))
 (type $19 (func (param i32 i32) (result i32)))
 (type $20 (func (param i32 i32) (result (ref null $voydEffectResult))))
 (type $21 (func (param i32 (ref null $10) i32) (result funcref)))
 (type $22 (func (param i32 (ref null $14)) (result funcref)))
 (type $23 (func (param (ref null $voydOutcome)) (result (ref null $voydOutcome))))
 (type $24 (func (param i32 i32 i32 i32) (result i32)))
 (type $25 (func (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
 (type $26 (func (param (ref null $voydOutcome) i32 i32) (result (ref null $voydEffectResult))))
 (type $27 (func (param (ref null $voydEffectRequest) i32) (result (ref null $voydOutcome))))
 (type $28 (func (param (ref null $voydEffectRequest) i32 i32) (result (ref null $voydEffectResult))))
 (type $29 (func (param (ref null $voydEffectResult)) (result i32)))
 (type $30 (func (param (ref null $voydEffectResult)) (result anyref)))
 (import "env" "__voyd_msgpack_write_value" (func $__voyd_msgpack_write_value (type $24) (param i32 i32 i32 i32) (result i32)))
 (import "env" "__voyd_msgpack_write_effect" (func $__voyd_msgpack_write_effect (type $25) (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
 (import "env" "__voyd_msgpack_read_value" (func $__voyd_msgpack_read_value (type $19) (param i32 i32) (result i32)))
 (memory $0 1 1)
 (elem declare func $__cont__proj_src_effects_continuation_compiler_voyd_block_test_4 $__cont__proj_src_effects_continuation_compiler_voyd_while_test_7)
 (export "block_test" (func $_proj_src_effects_continuation_compiler_voyd__block_test_4__wasm_export_block_test))
 (export "while_test" (func $_proj_src_effects_continuation_compiler_voyd__while_test_7__wasm_export_while_test))
 (export "memory" (memory $0))
 (export "handle_outcome" (func $_proj_src_effects_continuation_compiler_voyd__handle_outcome_0))
 (export "resume_continuation" (func $_proj_src_effects_continuation_compiler_voyd__resume_continuation))
 (export "resume_effectful" (func $_proj_src_effects_continuation_compiler_voyd__resume_effectful))
 (export "read_value" (func $_proj_src_effects_continuation_compiler_voyd__read_value))
 (export "effect_status" (func $_proj_src_effects_continuation_compiler_voyd__effect_status))
 (export "effect_cont" (func $_proj_src_effects_continuation_compiler_voyd__effect_cont))
 (export "block_test_effectful" (func $_proj_src_effects_continuation_compiler_voyd__block_test_effectful))
 (export "while_test_effectful" (func $_proj_src_effects_continuation_compiler_voyd__while_test_effectful))
 (func $__extends (type $15) (param $0 i32) (param $1 (ref null $13)) (result i32)
  (local $2 i32)
  (local.set $2
   (i32.const 0)
  )
  (loop $loop
   (if
    (i32.eq
     (local.get $2)
     (array.len
      (local.get $1)
     )
    )
    (then
     (return
      (i32.const 0)
     )
    )
   )
   (if
    (i32.eq
     (local.get $0)
     (array.get $13
      (local.get $1)
      (local.get $2)
     )
    )
    (then
     (return
      (i32.const 1)
     )
    )
   )
   (local.set $2
    (i32.add
     (local.get $2)
     (i32.const 1)
    )
   )
   (br $loop)
  )
 )
 (func $__has_type (type $15) (param $0 i32) (param $1 (ref null $13)) (result i32)
  (return
   (i32.eq
    (local.get $0)
    (array.get $13
     (local.get $1)
     (i32.const 0)
    )
   )
  )
 )
 (func $__lookup_field_accessor (type $21) (param $0 i32) (param $1 (ref null $10)) (param $2 i32) (result funcref)
  (local $3 i32)
  (local.set $3
   (i32.const 0)
  )
  (loop $loop
   (if
    (i32.eq
     (local.get $3)
     (array.len
      (local.get $1)
     )
    )
    (then
     (unreachable)
    )
   )
   (if
    (i32.eq
     (local.get $0)
     (struct.get $FieldAccessor $__field_hash
      (array.get $10
       (local.get $1)
       (local.get $3)
      )
     )
    )
    (then
     (return
      (if (result funcref)
       (i32.eq
        (local.get $2)
        (i32.const 0)
       )
       (then
        (struct.get $FieldAccessor $__field_getter
         (array.get $10
          (local.get $1)
          (local.get $3)
         )
        )
       )
       (else
        (struct.get $FieldAccessor $__field_setter
         (array.get $10
          (local.get $1)
          (local.get $3)
         )
        )
       )
      )
     )
    )
   )
   (local.set $3
    (i32.add
     (local.get $3)
     (i32.const 1)
    )
   )
   (br $loop)
  )
 )
 (func $__lookup_method_accessor (type $22) (param $0 i32) (param $1 (ref null $14)) (result funcref)
  (local $2 i32)
  (local.set $2
   (i32.const 0)
  )
  (loop $loop
   (if
    (i32.eq
     (local.get $2)
     (array.len
      (local.get $1)
     )
    )
    (then
     (unreachable)
    )
   )
   (if
    (i32.eq
     (local.get $0)
     (struct.get $MethodAccessor $__method_hash
      (array.get $14
       (local.get $1)
       (local.get $2)
      )
     )
    )
    (then
     (return
      (struct.get $MethodAccessor $__method_ref
       (array.get $14
        (local.get $1)
        (local.get $2)
       )
      )
     )
    )
   )
   (local.set $2
    (i32.add
     (local.get $2)
     (i32.const 1)
    )
   )
   (br $loop)
  )
 )
 (func $__cont__proj_src_effects_continuation_compiler_voyd_block_test_4 (type $11) (param $0 anyref) (param $1 eqref) (result (ref null $voydOutcome))
  (local $2 i32)
  (local $3 i32)
  (local $4 (ref null $voydHandlerFrame))
  (local $5 i32)
  (local $6 i32)
  (local $7 (ref null $voydOutcome))
  (local.set $6
   (struct.get $voydContEnvBase $site
    (ref.cast (ref null $voydContEnvBase)
     (local.get $0)
    )
   )
  )
  (local.set $5
   (i32.const 0)
  )
  (if
   (i32.eq
    (local.get $6)
    (i32.const 0)
   )
   (then
    (local.set $4
     (struct.get $voydContEnv__proj_src_effects_continuation_compiler_voyd_while_test_1 $handler
      (ref.cast (ref null $voydContEnv__proj_src_effects_continuation_compiler_voyd_while_test_1)
       (local.get $0)
      )
     )
    )
    (local.set $2
     (struct.get $voydContEnv__proj_src_effects_continuation_compiler_voyd_while_test_1 $sum
      (ref.cast (ref null $voydContEnv__proj_src_effects_continuation_compiler_voyd_while_test_1)
       (local.get $0)
      )
     )
    )
    (local.set $3
     (struct.get $voydContEnv__proj_src_effects_continuation_compiler_voyd_while_test_1 $v
      (ref.cast (ref null $voydContEnv__proj_src_effects_continuation_compiler_voyd_while_test_1)
       (local.get $0)
      )
     )
    )
   )
   (else
    (nop)
   )
  )
  (if (result (ref null $voydOutcome))
   (i32.or
    (i32.const 0)
    (i32.eq
     (local.get $6)
     (i32.const 0)
    )
   )
   (then
    (struct.new $voydOutcome
     (i32.const 0)
     (struct.new $voydOutcomeValue_0_2
      (block (result i32)
       (if
        (local.get $5)
        (then
         (local.set $2
          (i32.const 0)
         )
        )
        (else
         (nop)
        )
       )
       (if
        (local.get $5)
        (then
         (local.set $2
          (i32.add
           (local.get $2)
           (i32.const 1)
          )
         )
        )
        (else
         (nop)
        )
       )
       (if
        (i32.or
         (local.get $5)
         (i32.or
          (i32.const 0)
          (i32.eq
           (local.get $6)
           (i32.const 0)
          )
         )
        )
        (then
         (local.set $3
          (if (result i32)
           (i32.and
            (i32.eqz
             (local.get $5)
            )
            (i32.eq
             (local.get $6)
             (i32.const 0)
            )
           )
           (then
            (local.set $5
             (i32.const 1)
            )
            (struct.get $voydOutcomeValue_0_2 $value
             (ref.cast (ref null $voydOutcomeValue_0_2)
              (local.get $1)
             )
            )
           )
           (else
            (local.set $7
             (struct.new $voydOutcome
              (i32.const 1)
              (struct.new $voydEffectRequest
               (i32.const 0)
               (i32.const 0)
               (i32.const 0)
               (struct.new $voydOutcomeValue_0_2
                (i32.const 5)
               )
               (struct.new $voydContinuation
                (ref.func $__cont__proj_src_effects_continuation_compiler_voyd_block_test_4)
                (struct.new $voydContEnv__proj_src_effects_continuation_compiler_voyd_while_test_1
                 (i32.const 0)
                 (local.get $4)
                 (local.get $2)
                 (local.get $3)
                )
                (i32.const 0)
               )
               (struct.new $voydTailGuard
                (i32.const 1)
                (i32.const 0)
               )
              )
             )
            )
            (return
             (local.get $7)
            )
            (unreachable)
           )
          )
         )
        )
        (else
         (nop)
        )
       )
       (if
        (local.get $5)
        (then
         (local.set $2
          (i32.add
           (local.get $2)
           (local.get $3)
          )
         )
        )
        (else
         (nop)
        )
       )
       (local.get $2)
      )
     )
    )
   )
   (else
    (ref.null none)
   )
  )
 )
 (func $_proj_src_effects_continuation_compiler_voyd__block_test_4 (type $16) (param $0 (ref null $voydHandlerFrame)) (result (ref null $voydOutcome))
  (local $1 i32)
  (local $2 i32)
  (local $3 (ref null $voydOutcome))
  (struct.new $voydOutcome
   (i32.const 0)
   (struct.new $voydOutcomeValue_0_2
    (block (result i32)
     (block
      (local.set $1
       (i32.const 0)
      )
     )
     (local.set $1
      (i32.add
       (local.get $1)
       (i32.const 1)
      )
     )
     (block
      (local.set $2
       (block (result i32)
        (local.set $3
         (struct.new $voydOutcome
          (i32.const 1)
          (struct.new $voydEffectRequest
           (i32.const 0)
           (i32.const 0)
           (i32.const 0)
           (struct.new $voydOutcomeValue_0_2
            (i32.const 5)
           )
           (struct.new $voydContinuation
            (ref.func $__cont__proj_src_effects_continuation_compiler_voyd_block_test_4)
            (struct.new $voydContEnv__proj_src_effects_continuation_compiler_voyd_while_test_1
             (i32.const 0)
             (local.get $0)
             (local.get $1)
             (local.get $2)
            )
            (i32.const 0)
           )
           (struct.new $voydTailGuard
            (i32.const 1)
            (i32.const 0)
           )
          )
         )
        )
        (return
         (local.get $3)
        )
        (unreachable)
       )
      )
     )
     (local.set $1
      (i32.add
       (local.get $1)
       (local.get $2)
      )
     )
     (local.get $1)
    )
   )
  )
 )
 (func $__cont__proj_src_effects_continuation_compiler_voyd_while_test_7 (type $11) (param $0 anyref) (param $1 eqref) (result (ref null $voydOutcome))
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 (ref null $voydHandlerFrame))
  (local $7 i32)
  (local $8 i32)
  (local $9 i32)
  (local $10 (ref null $voydOutcome))
  (local.set $8
   (struct.get $voydContEnvBase $site
    (ref.cast (ref null $voydContEnvBase)
     (local.get $0)
    )
   )
  )
  (local.set $7
   (i32.const 0)
  )
  (if
   (i32.eq
    (local.get $8)
    (i32.const 1)
   )
   (then
    (local.set $6
     (struct.get $voydContEnv__proj_src_effects_continuation_compiler_voyd_while_test_1 $handler
      (ref.cast (ref null $voydContEnv__proj_src_effects_continuation_compiler_voyd_while_test_1)
       (local.get $0)
      )
     )
    )
    (local.set $3
     (struct.get $voydContEnv__proj_src_effects_continuation_compiler_voyd_while_test_1 $sum
      (ref.cast (ref null $voydContEnv__proj_src_effects_continuation_compiler_voyd_while_test_1)
       (local.get $0)
      )
     )
    )
    (local.set $5
     (struct.get $voydContEnv__proj_src_effects_continuation_compiler_voyd_while_test_1 $v
      (ref.cast (ref null $voydContEnv__proj_src_effects_continuation_compiler_voyd_while_test_1)
       (local.get $0)
      )
     )
    )
   )
   (else
    (nop)
   )
  )
  (if (result (ref null $voydOutcome))
   (i32.or
    (i32.const 0)
    (i32.eq
     (local.get $8)
     (i32.const 1)
    )
   )
   (then
    (struct.new $voydOutcome
     (i32.const 0)
     (struct.new $voydOutcomeValue_0_2
      (block (result i32)
       (if
        (local.get $7)
        (then
         (local.set $2
          (i32.const 0)
         )
        )
        (else
         (nop)
        )
       )
       (if
        (local.get $7)
        (then
         (local.set $3
          (i32.const 0)
         )
        )
        (else
         (nop)
        )
       )
       (if
        (local.get $7)
        (then
         (local.set $4
          (i32.const 5)
         )
        )
        (else
         (nop)
        )
       )
       (if
        (i32.or
         (local.get $7)
         (i32.or
          (i32.const 0)
          (i32.eq
           (local.get $8)
           (i32.const 1)
          )
         )
        )
        (then
         (block $while_loop_53_break
          (local.set $9
           (i32.and
            (i32.eqz
             (local.get $7)
            )
            (i32.and
             (i32.or
              (i32.const 0)
              (i32.eq
               (local.get $8)
               (i32.const 1)
              )
             )
             (i32.eqz
              (i32.const 0)
             )
            )
           )
          )
          (loop $while_loop_53
           (if
            (i32.eqz
             (local.get $9)
            )
            (then
             (if
              (i32.eqz
               (i32.lt_s
                (local.get $2)
                (local.get $4)
               )
              )
              (then
               (br $while_loop_53_break)
              )
             )
            )
            (else
             (nop)
            )
           )
           (local.set $9
            (i32.const 0)
           )
           (block
            (if
             (local.get $7)
             (then
              (local.set $2
               (i32.add
                (local.get $2)
                (i32.const 1)
               )
              )
             )
             (else
              (nop)
             )
            )
            (if
             (i32.or
              (local.get $7)
              (i32.or
               (i32.const 0)
               (i32.eq
                (local.get $8)
                (i32.const 1)
               )
              )
             )
             (then
              (local.set $5
               (if (result i32)
                (i32.and
                 (i32.eqz
                  (local.get $7)
                 )
                 (i32.eq
                  (local.get $8)
                  (i32.const 1)
                 )
                )
                (then
                 (local.set $7
                  (i32.const 1)
                 )
                 (struct.get $voydOutcomeValue_0_2 $value
                  (ref.cast (ref null $voydOutcomeValue_0_2)
                   (local.get $1)
                  )
                 )
                )
                (else
                 (local.set $10
                  (struct.new $voydOutcome
                   (i32.const 1)
                   (struct.new $voydEffectRequest
                    (i32.const 0)
                    (i32.const 0)
                    (i32.const 0)
                    (struct.new $voydOutcomeValue_0_2
                     (local.get $2)
                    )
                    (struct.new $voydContinuation
                     (ref.func $__cont__proj_src_effects_continuation_compiler_voyd_while_test_7)
                     (struct.new $voydContEnv__proj_src_effects_continuation_compiler_voyd_while_test_1
                      (i32.const 1)
                      (local.get $6)
                      (local.get $3)
                      (local.get $5)
                     )
                     (i32.const 1)
                    )
                    (struct.new $voydTailGuard
                     (i32.const 1)
                     (i32.const 0)
                    )
                   )
                  )
                 )
                 (return
                  (local.get $10)
                 )
                 (unreachable)
                )
               )
              )
             )
             (else
              (nop)
             )
            )
            (local.set $3
             (i32.add
              (local.get $3)
              (local.get $5)
             )
            )
           )
           (br $while_loop_53)
          )
         )
        )
        (else
         (nop)
        )
       )
       (local.get $3)
      )
     )
    )
   )
   (else
    (ref.null none)
   )
  )
 )
 (func $_proj_src_effects_continuation_compiler_voyd__while_test_7 (type $16) (param $0 (ref null $voydHandlerFrame)) (result (ref null $voydOutcome))
  (local $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 (ref null $voydOutcome))
  (struct.new $voydOutcome
   (i32.const 0)
   (struct.new $voydOutcomeValue_0_2
    (block (result i32)
     (block
      (local.set $1
       (i32.const 0)
      )
     )
     (block
      (local.set $2
       (i32.const 0)
      )
     )
     (block
      (local.set $3
       (i32.const 5)
      )
     )
     (block $while_loop_53_break
      (loop $while_loop_53
       (if
        (i32.eqz
         (i32.lt_s
          (local.get $1)
          (local.get $3)
         )
        )
        (then
         (br $while_loop_53_break)
        )
       )
       (block
        (local.set $1
         (i32.add
          (local.get $1)
          (i32.const 1)
         )
        )
        (block
         (local.set $4
          (block (result i32)
           (local.set $5
            (struct.new $voydOutcome
             (i32.const 1)
             (struct.new $voydEffectRequest
              (i32.const 0)
              (i32.const 0)
              (i32.const 0)
              (struct.new $voydOutcomeValue_0_2
               (local.get $1)
              )
              (struct.new $voydContinuation
               (ref.func $__cont__proj_src_effects_continuation_compiler_voyd_while_test_7)
               (struct.new $voydContEnv__proj_src_effects_continuation_compiler_voyd_while_test_1
                (i32.const 1)
                (local.get $0)
                (local.get $2)
                (local.get $4)
               )
               (i32.const 1)
              )
              (struct.new $voydTailGuard
               (i32.const 1)
               (i32.const 0)
              )
             )
            )
           )
           (return
            (local.get $5)
           )
           (unreachable)
          )
         )
        )
        (local.set $2
         (i32.add
          (local.get $2)
          (local.get $4)
         )
        )
       )
       (br $while_loop_53)
      )
     )
     (local.get $2)
    )
   )
  )
 )
 (func $__voyd_dispatch (type $23) (param $0 (ref null $voydOutcome)) (result (ref null $voydOutcome))
  (local $1 (ref null $voydHandlerFrame))
  (local $2 eqref)
  (local $3 (ref null $voydEffectRequest))
  (local $4 (ref null $voydOutcome))
  (local.set $4
   (local.get $0)
  )
  (loop $voyd_dispatch_loop
   (if
    (i32.eq
     (struct.get $voydOutcome $tag
      (local.get $4)
     )
     (i32.const 0)
    )
    (then
     (return
      (local.get $4)
     )
    )
    (else
     (nop)
    )
   )
   (local.set $3
    (ref.cast (ref null $voydEffectRequest)
     (struct.get $voydOutcome $payload
      (local.get $4)
     )
    )
   )
   (local.set $1
    (if (result (ref null $voydHandlerFrame))
     (ref.is_null
      (struct.get $voydEffectRequest $cont
       (local.get $3)
      )
     )
     (then
      (ref.null none)
     )
     (else
      (if (result (ref null $voydHandlerFrame))
       (ref.is_null
        (struct.get $voydContinuation $env
         (struct.get $voydEffectRequest $cont
          (local.get $3)
         )
        )
       )
       (then
        (ref.null none)
       )
       (else
        (struct.get $voydContEnvBase $handler
         (ref.cast (ref null $voydContEnvBase)
          (struct.get $voydContinuation $env
           (struct.get $voydEffectRequest $cont
            (local.get $3)
           )
          )
         )
        )
       )
      )
     )
    )
   )
   (local.set $2
    (local.get $1)
   )
   (loop $voyd_dispatch_frame
    (if
     (ref.is_null
      (local.get $2)
     )
     (then
      (return
       (local.get $4)
      )
     )
     (else
      (nop)
     )
    )
    (if
     (i32.and
      (i32.and
       (i32.eq
        (struct.get $voydHandlerFrame $effectId
         (ref.cast (ref null $voydHandlerFrame)
          (local.get $2)
         )
        )
        (struct.get $voydEffectRequest $effectId
         (local.get $3)
        )
       )
       (i32.eq
        (struct.get $voydHandlerFrame $opId
         (ref.cast (ref null $voydHandlerFrame)
          (local.get $2)
         )
        )
        (struct.get $voydEffectRequest $opId
         (local.get $3)
        )
       )
      )
      (i32.eq
       (struct.get $voydHandlerFrame $resumeKind
        (ref.cast (ref null $voydHandlerFrame)
         (local.get $2)
        )
       )
       (struct.get $voydEffectRequest $resumeKind
        (local.get $3)
       )
      )
     )
     (then
      (local.set $4
       (call_ref $17
        (local.get $1)
        (struct.get $voydHandlerFrame $clauseEnv
         (ref.cast (ref null $voydHandlerFrame)
          (local.get $2)
         )
        )
        (local.get $3)
        (ref.cast (ref $17)
         (struct.get $voydHandlerFrame $clauseFn
          (ref.cast (ref null $voydHandlerFrame)
           (local.get $2)
          )
         )
        )
       )
      )
      (br $voyd_dispatch_loop)
     )
     (else
      (nop)
     )
    )
    (local.set $2
     (struct.get $voydHandlerFrame $prev
      (ref.cast (ref null $voydHandlerFrame)
       (local.get $2)
      )
     )
    )
    (br $voyd_dispatch_frame)
   )
  )
 )
 (func $_proj_src_effects_continuation_compiler_voyd__block_test_4__wasm_export_block_test (type $18) (result i32)
  (local $0 (ref null $voydOutcome))
  (local.set $0
   (call $__voyd_dispatch
    (call $_proj_src_effects_continuation_compiler_voyd__block_test_4
     (ref.null none)
    )
   )
  )
  (if (result i32)
   (i32.eq
    (struct.get $voydOutcome $tag
     (local.get $0)
    )
    (i32.const 0)
   )
   (then
    (struct.get $voydOutcomeValue_0_2 $value
     (ref.cast (ref null $voydOutcomeValue_0_2)
      (struct.get $voydOutcome $payload
       (local.get $0)
      )
     )
    )
   )
   (else
    (unreachable)
   )
  )
 )
 (func $_proj_src_effects_continuation_compiler_voyd__while_test_7__wasm_export_while_test (type $18) (result i32)
  (local $0 (ref null $voydOutcome))
  (local.set $0
   (call $__voyd_dispatch
    (call $_proj_src_effects_continuation_compiler_voyd__while_test_7
     (ref.null none)
    )
   )
  )
  (if (result i32)
   (i32.eq
    (struct.get $voydOutcome $tag
     (local.get $0)
    )
    (i32.const 0)
   )
   (then
    (struct.get $voydOutcomeValue_0_2 $value
     (ref.cast (ref null $voydOutcomeValue_0_2)
      (struct.get $voydOutcome $payload
       (local.get $0)
      )
     )
    )
   )
   (else
    (unreachable)
   )
  )
 )
 (func $_proj_src_effects_continuation_compiler_voyd__handle_outcome_0 (type $26) (param $0 (ref null $voydOutcome)) (param $1 i32) (param $2 i32) (result (ref null $voydEffectResult))
  (local $3 (ref null $voydEffectRequest))
  (local $4 i32)
  (local $5 i32)
  (local.set $5
   (struct.get $voydOutcome $tag
    (local.get $0)
   )
  )
  (if
   (i32.eq
    (local.get $5)
    (i32.const 0)
   )
   (then
    (if
     (i32.ne
      (call $__voyd_msgpack_write_value
       (i32.const 1)
       (struct.get $voydOutcomeValue_0_2 $value
        (ref.cast (ref null $voydOutcomeValue_0_2)
         (struct.get $voydOutcome $payload
          (local.get $0)
         )
        )
       )
       (local.get $1)
       (local.get $2)
      )
      (i32.const 0)
     )
     (then
      (unreachable)
     )
     (else
      (nop)
     )
    )
    (return
     (struct.new $voydEffectResult
      (i32.const 0)
      (ref.null none)
     )
    )
   )
   (else
    (local.set $3
     (ref.cast (ref null $voydEffectRequest)
      (struct.get $voydOutcome $payload
       (local.get $0)
      )
     )
    )
    (local.set $4
     (i32.const 0)
    )
    (if
     (i32.and
      (i32.eq
       (struct.get $voydEffectRequest $effectId
        (local.get $3)
       )
       (i32.const 0)
      )
      (i32.eq
       (struct.get $voydEffectRequest $opId
        (local.get $3)
       )
       (i32.const 0)
      )
     )
     (then
      (i32.store
       (local.get $1)
       (struct.get $voydOutcomeValue_0_2 $value
        (ref.cast (ref null $voydOutcomeValue_0_2)
         (struct.get $voydEffectRequest $args
          (local.get $3)
         )
        )
       )
      )
      (local.set $4
       (i32.const 1)
      )
     )
    )
    (if
     (i32.ne
      (call $__voyd_msgpack_write_effect
       (struct.get $voydEffectRequest $effectId
        (local.get $3)
       )
       (struct.get $voydEffectRequest $opId
        (local.get $3)
       )
       (struct.get $voydEffectRequest $resumeKind
        (local.get $3)
       )
       (local.get $1)
       (local.get $4)
       (local.get $1)
       (local.get $2)
      )
      (i32.const 0)
     )
     (then
      (unreachable)
     )
     (else
      (nop)
     )
    )
    (return
     (struct.new $voydEffectResult
      (i32.const 1)
      (local.get $3)
     )
    )
   )
  )
 )
 (func $_proj_src_effects_continuation_compiler_voyd__resume_continuation (type $27) (param $0 (ref null $voydEffectRequest)) (param $1 i32) (result (ref null $voydOutcome))
  (local $2 (ref null $voydTailGuard))
  (local $3 (ref null $voydContinuation))
  (local.set $2
   (struct.get $voydEffectRequest $tailGuard
    (local.get $0)
   )
  )
  (local.set $3
   (struct.get $voydEffectRequest $cont
    (local.get $0)
   )
  )
  (if
   (ref.is_null
    (local.get $2)
   )
   (then
    (local.set $2
     (struct.new $voydTailGuard
      (i32.const 1)
      (i32.const 0)
     )
    )
   )
   (else
    (nop)
   )
  )
  (if
   (i32.and
    (i32.gt_u
     (struct.get $voydTailGuard $expected
      (local.get $2)
     )
     (i32.const 0)
    )
    (i32.ge_u
     (struct.get $voydTailGuard $observed
      (local.get $2)
     )
     (struct.get $voydTailGuard $expected
      (local.get $2)
     )
    )
   )
   (then
    (unreachable)
   )
   (else
    (nop)
   )
  )
  (struct.set $voydTailGuard $observed
   (local.get $2)
   (i32.add
    (struct.get $voydTailGuard $observed
     (local.get $2)
    )
    (i32.const 1)
   )
  )
  (if
   (i32.and
    (i32.eq
     (struct.get $voydEffectRequest $effectId
      (local.get $0)
     )
     (i32.const 0)
    )
    (i32.eq
     (struct.get $voydEffectRequest $opId
      (local.get $0)
     )
     (i32.const 0)
    )
   )
   (then
    (return
     (call_ref $11
      (struct.get $voydContinuation $env
       (local.get $3)
      )
      (struct.new $voydOutcomeValue_0_2
       (local.get $1)
      )
      (ref.cast (ref $11)
       (struct.get $voydContinuation $fn
        (local.get $3)
       )
      )
     )
    )
   )
  )
  (return
   (struct.new $voydOutcome
    (i32.const 1)
    (local.get $0)
   )
  )
 )
 (func $_proj_src_effects_continuation_compiler_voyd__resume_effectful (type $28) (param $0 (ref null $voydEffectRequest)) (param $1 i32) (param $2 i32) (result (ref null $voydEffectResult))
  (call $_proj_src_effects_continuation_compiler_voyd__handle_outcome_0
   (call $__voyd_dispatch
    (call $_proj_src_effects_continuation_compiler_voyd__resume_continuation
     (local.get $0)
     (call $__voyd_msgpack_read_value
      (local.get $1)
      (local.get $2)
     )
    )
   )
   (local.get $1)
   (local.get $2)
  )
 )
 (func $_proj_src_effects_continuation_compiler_voyd__read_value (type $19) (param $0 i32) (param $1 i32) (result i32)
  (call $__voyd_msgpack_read_value
   (local.get $0)
   (local.get $1)
  )
 )
 (func $_proj_src_effects_continuation_compiler_voyd__effect_status (type $29) (param $0 (ref null $voydEffectResult)) (result i32)
  (struct.get $voydEffectResult $status
   (local.get $0)
  )
 )
 (func $_proj_src_effects_continuation_compiler_voyd__effect_cont (type $30) (param $0 (ref null $voydEffectResult)) (result anyref)
  (struct.get $voydEffectResult $cont
   (local.get $0)
  )
 )
 (func $_proj_src_effects_continuation_compiler_voyd__block_test_effectful (type $20) (param $0 i32) (param $1 i32) (result (ref null $voydEffectResult))
  (call $_proj_src_effects_continuation_compiler_voyd__handle_outcome_0
   (call $__voyd_dispatch
    (call $_proj_src_effects_continuation_compiler_voyd__block_test_4
     (ref.null none)
    )
   )
   (local.get $0)
   (local.get $1)
  )
 )
 (func $_proj_src_effects_continuation_compiler_voyd__while_test_effectful (type $20) (param $0 i32) (param $1 i32) (result (ref null $voydEffectResult))
  (call $_proj_src_effects_continuation_compiler_voyd__handle_outcome_0
   (call $__voyd_dispatch
    (call $_proj_src_effects_continuation_compiler_voyd__while_test_7
     (ref.null none)
    )
   )
   (local.get $0)
   (local.get $1)
  )
 )
 ;; custom section "__voyd_effect_table", size 150
)
